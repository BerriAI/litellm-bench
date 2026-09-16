import { NodeHttpServer } from "@effect/platform-node";
import {
  decodeUpstreamFixture,
  type Json,
  type MockOperation,
  type MockStats,
  type RequestMismatchDiagnostic,
  type UpstreamFixture,
} from "@litellm-bench/contracts";
import { Context, Data, Effect, Exit, Layer, Ref, Schema, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { crc32 } from "node:zlib";

export { type Json, type MockStats } from "@litellm-bench/contracts";
/** Preserve the input document for callers that validate before starting the server. */
export const validateFixture = (value: unknown): UpstreamFixture => {
  decodeUpstreamFixture(value);
  return value as UpstreamFixture;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const matches = (actual: unknown, expected: Json): boolean => {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length
      && expected.every((item, index) => matches(actual[index], item));
  }
  if (isRecord(expected)) {
    return isRecord(actual)
      && Object.entries(expected).every(([key, value]) =>
        Object.hasOwn(actual, key) && matches(actual[key], value)
      );
  }
  return actual === expected;
};

export const PngExpectation = Schema.Struct({
  path: Schema.NonEmptyString,
  bytes: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  sha256: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/, { expected: "a lowercase SHA-256 digest" })),
  ),
});
export type PngExpectation = typeof PngExpectation.Type;

const pngBytes = (value: unknown): Buffer | undefined => {
  const prefix = "data:image/png;base64,";
  if (typeof value !== "string" || !value.startsWith(prefix)) return undefined;
  const encoded = value.slice(prefix.length);
  if (encoded.length === 0) return undefined;
  const bytes = Buffer.from(encoded, "base64");
  // Re-encoding reproduces the input only for canonical base64 (alphabet, padding, no whitespace).
  if (bytes.toString("base64") !== encoded) return undefined;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!bytes.subarray(0, 8).equals(signature)) return undefined;
  let offset = 8;
  let chunks = 0;
  let sawIdat = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return undefined;
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString("ascii");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(data, crc32(typeBytes)) >>> 0;
    if (actualCrc !== expectedCrc) return undefined;
    if (chunks === 0 && (type !== "IHDR" || length !== 13)) return undefined;
    if (type === "IDAT") sawIdat = true;
    offset = end;
    chunks += 1;
    if (type === "IEND") {
      return length === 0 && sawIdat && offset === bytes.length
        ? bytes
        : undefined;
    }
  }
  return undefined;
};

export const isPngDocument = (value: unknown, expected?: PngExpectation): boolean => {
  const bytes = pngBytes(value);
  return bytes !== undefined
    && (expected === undefined || (
      bytes.byteLength === expected.bytes
      && createHash("sha256").update(bytes).digest("hex") === expected.sha256
    ));
};

export const decodePngExpectations = (value: unknown): readonly PngExpectation[] => {
  try {
    return Schema.decodeUnknownSync(Schema.Array(PngExpectation), { onExcessProperty: "error" })(
      value,
    );
  } catch (error) {
    throw new Error(
      Array.isArray(value) ? "invalid PNG expectation" : "PNG expectations must be an array",
      { cause: error },
    );
  }
};

const nested = (value: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>(
    (current, part) =>
      isRecord(current) && Object.hasOwn(current, part) ? current[part] : undefined,
    value,
  );

export class FixtureError extends Data.TaggedError("FixtureError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class RequestMismatch extends Data.TaggedError("RequestMismatch")<{
  readonly reason:
    | "method_or_path"
    | "request_body"
    | "request_headers"
    | "png_document"
    | "ambiguous_match";
  readonly operationId?: string;
  readonly detail: string;
}> {}

const selectedOptionalBody = (fixture: MockOperation, body: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(fixture.optional_expect ?? {}).filter(([key]) => Object.hasOwn(body, key)),
  );

const includeDynamicField = (
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  path: string,
) => {
  const parts = path.split(".");
  let expectedParent = expected;
  let actualParent: Record<string, unknown> = actual;
  for (const part of parts.slice(0, -1)) {
    const expectedChild = expectedParent[part];
    const actualChild = actualParent[part];
    if (!isRecord(expectedChild) || !isRecord(actualChild)) return;
    expectedParent = expectedChild;
    actualParent = actualChild;
  }
  const leaf = parts.at(-1)!;
  if (Object.hasOwn(actualParent, leaf)) expectedParent[leaf] = actualParent[leaf];
};

const exactExpectedBody = (fixture: MockOperation, body: Record<string, unknown>): Json => {
  const expected = structuredClone({
    ...fixture.expect,
    ...selectedOptionalBody(fixture, body),
  }) as Record<string, unknown>;
  for (const field of fixture.png_fields ?? []) includeDynamicField(expected, body, field);
  return expected as Json;
};

const redacted = (value: unknown): unknown => {
  if (typeof value === "string" && value.startsWith("data:image/")) {
    return `<image data URL, ${value.length} characters>`;
  }
  if (Array.isArray(value)) return value.map(redacted);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redacted(item)]));
  }
  return value;
};

const summarized = (value: unknown): string => {
  const encoded = JSON.stringify(redacted(value));
  if (encoded === undefined) return String(value);
  return encoded.length <= 160 ? encoded : `${encoded.slice(0, 157)}...`;
};

const bodyMismatchDetail = (body: unknown, fixture: MockOperation): string => {
  if (!isRecord(body)) return "request body is not a JSON object";
  const expected = exactExpectedBody(fixture, body) as Record<string, Json>;
  const missing = Object.keys(expected).filter((key) => !Object.hasOwn(body, key));
  const unexpected = fixture.body_match === "exact"
    ? Object.keys(body).filter((key) => !Object.hasOwn(expected, key))
    : [];
  const different = Object.entries(expected).filter(([key, value]) =>
    Object.hasOwn(body, key) && !matches(body[key], value)
  );
  const parts = [
    ...(missing.length === 0 ? [] : [`missing fields: ${missing.join(", ")}`]),
    ...(unexpected.length === 0 ? [] : [`unexpected fields: ${unexpected.join(", ")}`]),
    ...different.map(([key, value]) =>
      `field ${key}: expected ${summarized(value)}, received ${summarized(body[key])}`
    ),
  ];
  return parts.join("; ") || "request body did not match any operation";
};

export const encodeSse = (event: { readonly event?: string; readonly data: Json }): string => {
  const data = typeof event.data === "string" ? event.data : JSON.stringify(event.data);
  return `${event.event === undefined ? "" : `event: ${event.event}\n`}${
    data.split(/\r\n|\r|\n/).map((line) => `data: ${line}`).join("\n")
  }\n\n`;
};

interface CompiledOperation {
  readonly fixture: MockOperation;
  readonly bytes: readonly (readonly Uint8Array[])[];
}

export const fragmentBytes = (bytes: Uint8Array, maximum?: number): readonly Uint8Array[] => {
  if (maximum === undefined || bytes.byteLength <= maximum) return [bytes];
  const fragments: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += maximum) {
    fragments.push(bytes.subarray(offset, Math.min(offset + maximum, bytes.byteLength)));
  }
  return fragments;
};

const compileResponse = (fixture: MockOperation): readonly (readonly Uint8Array[])[] => {
  const response = fixture.response;
  if (response.kind === "json") return [[Buffer.from(JSON.stringify(response.body))]];
  return response.events.map((event) =>
    fragmentBytes(Buffer.from(encodeSse(event)), response.max_write_bytes)
  );
};

export class OperationRegistry extends Context.Service<OperationRegistry, {
  readonly select: (
    method: string,
    path: string,
    body: unknown,
    headers: Readonly<Record<string, string | undefined>>,
  ) => Effect.Effect<CompiledOperation, RequestMismatch>;
}>()("@litellm-bench/mock-provider/OperationRegistry") {}

export const registryLayer = (input: unknown, pngExpectations: readonly PngExpectation[] = []) =>
  Layer.effect(
    OperationRegistry,
    Effect.gen(function*() {
      const operations = yield* Effect.try({
        try: () =>
          decodeUpstreamFixture(input).map((fixture): CompiledOperation => ({
            fixture,
            bytes: compileResponse(fixture),
          })),
        catch: (cause) => new FixtureError({ message: "invalid upstream fixture", cause }),
      });
      return {
        select: (method: string, path: string, body: unknown, headers) =>
          Effect.gen(function*() {
            const routes = operations.filter(({ fixture }) =>
              fixture.method === method && fixture.path === path
            );
            if (routes.length === 0) {
              return yield* new RequestMismatch({
                reason: "method_or_path",
                detail: `no operation accepts ${method} ${path}`,
              });
            }
            const candidates = routes.filter(({ fixture }) =>
              isRecord(body) && matches(body, fixture.expect)
              && matches(
                body,
                Object.fromEntries(
                  Object.entries(fixture.optional_expect ?? {})
                    .filter(([key]) => Object.hasOwn(body, key)),
                ),
              )
            );
            if (candidates.length === 0) {
              const candidate = routes[0]!;
              return yield* new RequestMismatch({
                reason: "request_body",
                ...(routes.length === 1 ? { operationId: candidate.fixture.id } : {}),
                detail: routes.length === 1
                  ? bodyMismatchDetail(body, candidate.fixture)
                  : `request body matched none of: ${
                    routes.map(({ fixture }) => fixture.id).join(", ")
                  }`,
              });
            }
            if (candidates.length > 1) {
              return yield* new RequestMismatch({
                reason: "ambiguous_match",
                detail: `request body matched multiple operations: ${
                  candidates.map(({ fixture }) => fixture.id).join(", ")
                }`,
              });
            }
            const selected = candidates[0]!;
            const headersMatch = Object.entries(selected.fixture.expect_headers ?? {}).every(
              ([name, expected]) => {
                const actual = headers[name.toLowerCase()]?.trim();
                if (actual === undefined) return false;
                return name.toLowerCase() === "content-type"
                  ? actual.split(";", 1)[0]?.trim().toLowerCase() === expected.toLowerCase()
                  : actual === expected;
              },
            );
            if (!headersMatch) {
              const missingOrDifferent = Object.keys(selected.fixture.expect_headers ?? {}).filter(
                (name) => {
                  const actual = headers[name.toLowerCase()]?.trim();
                  const expected = selected.fixture.expect_headers?.[name];
                  return actual === undefined || (name.toLowerCase() === "content-type"
                    ? actual.split(";", 1)[0]?.trim().toLowerCase() !== expected?.toLowerCase()
                    : actual !== expected);
                },
              );
              return yield* new RequestMismatch({
                reason: "request_headers",
                operationId: selected.fixture.id,
                detail: `missing or different headers: ${missingOrDifferent.join(", ")}`,
              });
            }
            const exactBody = selected.fixture.body_match === "exact"
              ? exactExpectedBody(selected.fixture, body as Record<string, unknown>)
              : undefined;
            if (
              exactBody !== undefined
              && (!matches(body, exactBody) || !matches(exactBody, body as Json))
            ) {
              return yield* new RequestMismatch({
                reason: "request_body",
                operationId: selected.fixture.id,
                detail: bodyMismatchDetail(body, selected.fixture),
              });
            }
            if (
              (selected.fixture.png_fields ?? []).some((field) =>
                !isPngDocument(
                  nested(body, field),
                  pngExpectations.find((expectation) => expectation.path === field),
                )
              )
            ) {
              return yield* new RequestMismatch({
                reason: "png_document",
                operationId: selected.fixture.id,
                detail: `invalid image fields: ${(selected.fixture.png_fields ?? []).join(", ")}`,
              });
            }
            return selected;
          }),
      };
    }),
  );

export class Statistics extends Context.Service<Statistics, Ref.Ref<MockStats>>()(
  "@litellm-bench/mock-provider/Statistics",
) {}
export const emptyStats: MockStats = { requests: 0, failures: 0, errors: {} };
export const statisticsLayer = (statistics?: Ref.Ref<MockStats>) =>
  Layer.effect(
    Statistics,
    statistics === undefined ? Ref.make(emptyStats) : Effect.succeed(statistics),
  );

const emptyStreams = { started: 0, completed: 0, cancelled: 0, failed: 0 };

const sumRecords = (
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): Record<string, number> =>
  Object.fromEntries(
    [...new Set([...Object.keys(left), ...Object.keys(right)])].map((key) => [
      key,
      (left[key] ?? 0) + (right[key] ?? 0),
    ]),
  );

/** Adds counters from sibling processes; stream stats appear only when some process reported them. */
export const mergeStats = (left: MockStats, right: MockStats): MockStats => ({
  requests: left.requests + right.requests,
  failures: left.failures + right.failures,
  errors: sumRecords(left.errors, right.errors),
  ...(left.streams === undefined && right.streams === undefined ? {} : {
    streams: {
      started: (left.streams?.started ?? 0) + (right.streams?.started ?? 0),
      completed: (left.streams?.completed ?? 0) + (right.streams?.completed ?? 0),
      cancelled: (left.streams?.cancelled ?? 0) + (right.streams?.cancelled ?? 0),
      failed: (left.streams?.failed ?? 0) + (right.streams?.failed ?? 0),
    },
  }),
  ...(left.last_mismatch === undefined
    ? right.last_mismatch === undefined ? {} : { last_mismatch: right.last_mismatch }
    : { last_mismatch: left.last_mismatch }),
});
const streamStat = (stats: Ref.Ref<MockStats>, key: keyof typeof emptyStreams) =>
  Ref.update(stats, (current) => ({
    ...current,
    streams: {
      ...(current.streams ?? emptyStreams),
      [key]: (current.streams ?? emptyStreams)[key] + 1,
    },
  }));

/** Delay the first event separately; pacing applies between events, never after the terminal event. */
export const pacedStream = (
  groups: readonly (Uint8Array | readonly Uint8Array[])[],
  timing: { readonly first_event_delay_ms: number; readonly event_interval_ms: number },
) =>
  Stream.fromIterable(groups).pipe(
    Stream.mapEffect((group, index) =>
      Effect.sleep(
        index === 0 ? timing.first_event_delay_ms : timing.event_interval_ms,
      ).pipe(Effect.as(group instanceof Uint8Array ? [group] : group))
    ),
    Stream.flatMap(Stream.fromIterable),
  );

const application = (readStats: (local: MockStats) => Effect.Effect<MockStats>) =>
  Effect.gen(function*() {
    const registry = yield* OperationRegistry;
    const stats = yield* Statistics;
    const router = yield* HttpRouter.make;
    yield* router.add(
      "GET",
      "/__stats",
      Ref.get(stats).pipe(Effect.flatMap(readStats), Effect.map(HttpServerResponse.jsonUnsafe)),
    );
    yield* router.add(
      "*",
      "/*",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        yield* Ref.update(stats, (current) => ({ ...current, requests: current.requests + 1 }));
        const body = request.method === "GET" || request.method === "HEAD"
          ? {}
          : yield* request.json.pipe(Effect.catch(() => Effect.succeed(undefined)));
        return yield* registry.select(request.method, request.url, body, request.headers).pipe(
          Effect.flatMap(({ fixture, bytes }) =>
            Effect.gen(function*() {
              const response = fixture.response;
              const options = { status: response.status ?? 200, headers: response.headers ?? {} };
              if (response.kind === "json") {
                yield* Effect.sleep(response.timing.response_delay_ms);
                return HttpServerResponse.uint8Array(bytes[0]![0]!, {
                  ...options,
                  contentType: "application/json",
                });
              }
              yield* streamStat(stats, "started");
              const stream = pacedStream(bytes, response.timing).pipe(
                Stream.onExit((exit) =>
                  streamStat(
                    stats,
                    Exit.isSuccess(exit)
                      ? "completed"
                      : Exit.hasInterrupts(exit)
                      ? "cancelled"
                      : "failed",
                  )
                ),
              );
              return HttpServerResponse.stream(stream, {
                ...options,
                contentType: "text/event-stream",
                headers: {
                  "cache-control": "no-cache",
                  "x-accel-buffering": "no",
                  ...options.headers,
                },
              });
            })
          ),
          Effect.catchTag(
            "RequestMismatch",
            ({ detail, operationId, reason }) =>
              Effect.gen(function*() {
                const diagnostic: RequestMismatchDiagnostic = {
                  reason,
                  method: request.method,
                  path: request.url,
                  ...(operationId === undefined ? {} : { operation_id: operationId }),
                  detail,
                };
                yield* Ref.update(stats, (current) => ({
                  ...current,
                  failures: current.failures + 1,
                  errors: { ...current.errors, [reason]: (current.errors[reason] ?? 0) + 1 },
                  last_mismatch: diagnostic,
                }));
                return HttpServerResponse.jsonUnsafe({ error: reason }, { status: 422 });
              }),
          ),
        );
      }),
    );
    return router.asHttpEffect();
  });

export interface MockServerOptions {
  readonly port?: number;
  readonly host?: string;
  readonly pngExpectations?: readonly PngExpectation[];
  /** Counters this server increments; supply one to observe them outside the request path. */
  readonly statistics?: Ref.Ref<MockStats>;
  /** Combines this process's counters with sibling processes' before `/__stats` answers. */
  readonly readStats?: (local: MockStats) => Effect.Effect<MockStats>;
}

/** Acquire a server in the caller's scope; closing that scope interrupts active requests. */
export const createMockServer = (fixture: unknown, options: MockServerOptions = {}) =>
  Effect.gen(function*() {
    const app = yield* application(options.readStats ?? Effect.succeed).pipe(
      Effect.provide(Layer.merge(
        registryLayer(fixture, options.pngExpectations),
        statisticsLayer(options.statistics),
      )),
    );
    const server = yield* NodeHttpServer.make(createServer, {
      port: options.port ?? 8080,
      host: options.host ?? "0.0.0.0",
      disablePreemptiveShutdown: true,
    });
    yield* server.serve(app);
    return server;
  }).pipe(Effect.provide(NodeHttpServer.layerHttpServices));
