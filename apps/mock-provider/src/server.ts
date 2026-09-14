import { NodeHttpServer } from "@effect/platform-node";
import {
  decodeUpstreamFixture,
  type Json,
  type MockOperation,
  type MockStats,
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
  if (encoded.length === 0 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return undefined;
  }
  const bytes = Buffer.from(encoded, "base64");
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
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0;
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
}> {}

export const encodeSse = (event: { readonly event?: string; readonly data: Json }): string => {
  const data = typeof event.data === "string" ? event.data : JSON.stringify(event.data);
  return `${event.event === undefined ? "" : `event: ${event.event}\n`}${
    data.split(/\r\n|\r|\n/).map((line) => `data: ${line}`).join("\n")
  }\n\n`;
};

interface CompiledOperation {
  readonly fixture: MockOperation;
  readonly bytes: readonly Uint8Array[];
}

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
            bytes: fixture.response.kind === "json"
              ? [Buffer.from(JSON.stringify(fixture.response.body))]
              : fixture.response.events.map((event) => Buffer.from(encodeSse(event))),
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
              return yield* new RequestMismatch({ reason: "method_or_path" });
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
              return yield* new RequestMismatch({ reason: "request_body" });
            }
            if (candidates.length > 1) {
              return yield* new RequestMismatch({ reason: "ambiguous_match" });
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
              return yield* new RequestMismatch({ reason: "request_headers" });
            }
            if (
              selected.fixture.body_match === "exact"
              && (
                !matches(body, selected.fixture.expect)
                || !matches(selected.fixture.expect, body as Json)
              )
            ) {
              return yield* new RequestMismatch({ reason: "request_body" });
            }
            if (
              (selected.fixture.png_fields ?? []).some((field) =>
                !isPngDocument(
                  nested(body, field),
                  pngExpectations.find((expectation) => expectation.path === field),
                )
              )
            ) {
              return yield* new RequestMismatch({ reason: "png_document" });
            }
            return selected;
          }),
      };
    }),
  );

export class Statistics extends Context.Service<Statistics, Ref.Ref<MockStats>>()(
  "@litellm-bench/mock-provider/Statistics",
) {}
export const statisticsLayer = Layer.effect(
  Statistics,
  Ref.make<MockStats>({ requests: 0, failures: 0, errors: {} }),
);

const emptyStreams = { started: 0, completed: 0, cancelled: 0, failed: 0 };
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
  bytes: readonly Uint8Array[],
  timing: { readonly first_event_delay_ms: number; readonly event_interval_ms: number },
) =>
  Stream.fromIterable(bytes).pipe(
    Stream.mapEffect((bytes, index) =>
      Effect.sleep(
        index === 0 ? timing.first_event_delay_ms : timing.event_interval_ms,
      ).pipe(Effect.as(bytes))
    ),
  );

const application = Effect.gen(function*() {
  const registry = yield* OperationRegistry;
  const stats = yield* Statistics;
  const router = yield* HttpRouter.make;
  yield* router.add(
    "GET",
    "/__stats",
    Ref.get(stats).pipe(Effect.map(HttpServerResponse.jsonUnsafe)),
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
              return HttpServerResponse.uint8Array(bytes[0]!, {
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
        Effect.catchTag("RequestMismatch", ({ reason }) =>
          Effect.gen(function*() {
            yield* Ref.update(stats, (current) => ({
              ...current,
              failures: current.failures + 1,
              errors: { ...current.errors, [reason]: (current.errors[reason] ?? 0) + 1 },
            }));
            return HttpServerResponse.jsonUnsafe({ error: reason }, { status: 422 });
          })),
      );
    }),
  );
  return router.asHttpEffect();
});

export interface MockServerOptions {
  readonly port?: number;
  readonly host?: string;
  readonly pngExpectations?: readonly PngExpectation[];
}

/** Acquire a server in the caller's scope; closing that scope interrupts active requests. */
export const createMockServer = (fixture: unknown, options: MockServerOptions = {}) =>
  Effect.gen(function*() {
    const app = yield* application.pipe(
      Effect.provide(Layer.merge(registryLayer(fixture, options.pngExpectations), statisticsLayer)),
    );
    const server = yield* NodeHttpServer.make(createServer, {
      port: options.port ?? 8080,
      host: options.host ?? "0.0.0.0",
      disablePreemptiveShutdown: true,
    });
    yield* server.serve(app);
    return server;
  }).pipe(Effect.provide(NodeHttpServer.layerHttpServices));
