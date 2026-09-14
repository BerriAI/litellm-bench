import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, FileSystem, Path, Ref, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, describe } from "vitest";
import { chatCompletion, ocr, responses } from "./operations.js";
import {
  createMockServer,
  decodePngExpectations,
  encodeSse,
  isPngDocument,
  matches,
  pacedStream,
  validateFixture,
} from "./server.js";

const single = {
  version: 2,
  operations: [{
    id: "test",
    operation: "generic",
    method: "POST",
    path: "/v1/test",
    expect: { model: "bench", nested: { enabled: true } },
    optional_expect: { stream: false },
    response: {
      kind: "json",
      timing: { response_delay_ms: 0 },
      body: { ok: true },
    },
  }],
};
const scopes: Scope.Closeable[] = [];
const readFile = (location: string | URL, _encoding: "utf8") =>
  Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return yield* fs.readFileString(
        location instanceof URL ? yield* path.fromFileUrl(location) : location,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
const start = async (fixture: unknown) => {
  const scope = Scope.makeUnsafe();
  scopes.push(scope);
  const server = await Effect.runPromise(
    createMockServer(fixture, { port: 0, host: "127.0.0.1" }).pipe(Scope.provide(scope)),
  );
  if (server.address._tag === "UnixPathAddress") throw new Error("expected TCP");
  const base = `http://127.0.0.1:${server.address.port}`;
  return {
    scope,
    post: (
      path: string,
      body: unknown,
      signal?: AbortSignal,
      headers: Readonly<Record<string, string>> = {},
    ) =>
      fetch(base + path, {
        method: "POST",
        body: JSON.stringify(body),
        headers,
        ...(signal === undefined ? {} : { signal }),
      }),
    get: (path: string) => fetch(base + path),
    raw: (body: string) => fetch(base + "/v1/test", { method: "POST", body }),
    stats: async () => (await fetch(base + "/__stats")).json(),
  };
};
afterEach(async () => {
  await Promise.all(
    scopes.splice(0).map((scope) => Effect.runPromise(Scope.close(scope, Exit.void))),
  );
});

const multi = {
  version: 2,
  operations: [
    ocr({
      id: "ocr",
      model: "ocr",
      markdown: "page",
      timing: { responseDelayMs: 0 },
    }),
    chatCompletion({
      id: "chat",
      model: "bench",
      chunks: ["Hello", " world"],
      timing: { responseDelayMs: 0 },
    }),
    chatCompletion({
      id: "chat-stream",
      model: "bench",
      chunks: ["Hello", " world"],
      stream: true,
      timing: { firstEventDelayMs: 0, eventIntervalMs: 0 },
      includeUsage: true,
    }),
    responses({
      id: "response",
      model: "bench",
      chunks: ["Hello", " world"],
      timing: { responseDelayMs: 0 },
    }),
    responses({
      id: "response-stream",
      model: "bench",
      chunks: ["Hello", " world"],
      stream: true,
      timing: { firstEventDelayMs: 0, eventIntervalMs: 0 },
    }),
  ],
};
const parseSse = (text: string) =>
  text.trim().split("\n\n").map((frame) => {
    const lines = frame.split("\n");
    const raw = lines.filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join(
      "\n",
    );
    return {
      event: lines.find((line) => line.startsWith("event: "))?.slice(7),
      data: raw === "[DONE]" ? raw : JSON.parse(raw),
    };
  });

describe("mock provider", () => {
  it("matches object subsets, exact arrays, and PNG documents", () => {
    expect(matches({ a: 1, extra: true }, { a: 1 })).toBe(true);
    expect(matches([1, 2, 3], [1, 2])).toBe(false);
    expect(matches({}, { toString: "no" })).toBe(false);
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    expect(isPngDocument(png)).toBe(true);
    expect(isPngDocument(png, {
      path: "document.image_url",
      bytes: 68,
      sha256: "431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460",
    })).toBe(true);
    expect(isPngDocument(png, {
      path: "document.image_url",
      bytes: 67,
      sha256: "431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460",
    })).toBe(false);
    expect(isPngDocument("data:image/png;base64,bm90LXBuZw==")).toBe(false);
    expect(encodeSse({ event: "example", data: "a\nb" })).toBe(
      "event: example\ndata: a\ndata: b\n\n",
    );
    const expectation = {
      path: "document.image_url",
      bytes: 68,
      sha256: "431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460",
    };
    expect(decodePngExpectations([expectation])).toEqual([expectation]);
    expect(() => decodePngExpectations({})).toThrow("PNG expectations must be an array");
    expect(() => decodePngExpectations([{ ...expectation, path: "" }])).toThrow(
      "invalid PNG expectation",
    );
    expect(() => decodePngExpectations([{ ...expectation, bytes: 0 }])).toThrow(
      "invalid PNG expectation",
    );
    expect(() => decodePngExpectations([{ ...expectation, bytes: 1.5 }])).toThrow(
      "invalid PNG expectation",
    );
    expect(() => decodePngExpectations([{ ...expectation, extra: true }])).toThrow(
      "invalid PNG expectation",
    );
  });

  it("serves JSON responses and records rejection reasons", async () => {
    const server = await start(validateFixture(single));
    expect(
      await (await server.post("/v1/test", { model: "bench", nested: { enabled: true } })).json(),
    ).toEqual({ ok: true });
    expect(
      (await server.post("/v1/test", { model: "bench", nested: { enabled: true }, stream: true }))
        .status,
    ).toBe(422);
    expect((await server.raw("not json")).status).toBe(422);
    expect(await (await server.post("/missing", {})).json()).toEqual({ error: "method_or_path" });
    expect(await server.stats()).toEqual({
      requests: 4,
      failures: 3,
      errors: { request_body: 2, method_or_path: 1 },
    });
  });

  it("loads both existing benchmark fixtures", async () => {
    for (const name of ["proxy-ocr", "proxy-chat-completions"]) {
      const fixture = JSON.parse(
        await readFile(
          new URL(`../../../benchmarks/${name}/upstream.json`, import.meta.url),
          "utf8",
        ),
      );
      const server = await start(fixture);
      const operation = fixture.operations[0];
      const body = name === "proxy-ocr"
        ? {
          ...operation.expect,
          document: {
            type: "image_url",
            image_url:
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          },
        }
        : operation.expect;
      expect(
        await (await server.post(
          operation.path,
          body,
          undefined,
          name === "proxy-chat-completions"
            ? { authorization: "Bearer sk-mock", "content-type": "application/json; charset=utf-8" }
            : {},
        )).json(),
      ).toEqual(operation.response.body);
      if (name === "proxy-chat-completions") {
        expect(
          (await server.post(operation.path, { ...body, extra: true }, undefined, {
            authorization: "Bearer sk-mock",
            "content-type": "application/json",
          })).status,
        ).toBe(422);
        expect(
          (await server.post(operation.path, body, undefined, {
            authorization: "Bearer wrong",
            "content-type": "application/json",
          })).status,
        ).toBe(422);
      }
    }
  });

  it("loads the streaming chat benchmark fixture", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL(
          "../../../benchmarks/proxy-chat-completions-streaming/upstream.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const operation = fixture.operations[0];
    const server = await start(fixture);
    const response = await server.post(operation.path, operation.expect, undefined, {
      authorization: "Bearer sk-mock",
      "content-type": "application/json; charset=utf-8",
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSse(await response.text());
    expect(events).toHaveLength(7);
    expect(events.slice(1, 5).map((event) => event.data.choices[0].delta.content).join(""))
      .toBe("mock streaming chat response");
    expect(events.at(-1)?.data).toBe("[DONE]");
  });

  it("serves OCR, chat, and Responses together with protocol-specific streams", async () => {
    const server = await start(multi);
    const chat = await (await server.post("/v1/chat/completions", { model: "bench" })).json();
    expect(chat.choices[0].message.content).toBe("Hello world");
    expect(
      await (await server.post("/v1/ocr", {
        model: "ocr",
        document: { type: "image_url", image_url: "invalid" },
      })).json(),
    ).toEqual({ error: "png_document" });
    const response = await (await server.post("/v1/responses", { model: "bench" })).json();
    expect(response.output[0].content[0].text).toBe("Hello world");
    const streamed = await server.post("/v1/chat/completions", { model: "bench", stream: true });
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    expect(streamed.headers.has("content-length")).toBe(false);
    const chunks = parseSse(await streamed.text());
    expect(chunks.at(-1)?.data).toBe("[DONE]");
    expect(chunks.at(-2)?.data.usage.total_tokens).toBe(3);
    expect(chunks.slice(1, 3).map((chunk) => chunk.data.choices[0].delta.content).join("")).toBe(
      "Hello world",
    );
    const events = parseSse(
      await (await server.post("/v1/responses", { model: "bench", stream: true })).text(),
    );
    expect(events.map((event) => event.data.sequence_number)).toEqual(
      events.map((_, index) => index),
    );
    expect(events.every((event) => event.event === event.data.type)).toBe(true);
    expect(events[0]?.event).toBe("response.created");
    expect(events.at(-1)?.event).toBe("response.completed");
    expect(events.at(-1)?.data.response.output[0].content).toEqual(response.output[0].content);
    expect((await server.stats()).streams).toEqual({
      started: 2,
      completed: 2,
      cancelled: 0,
      failed: 0,
    });
  });

  it("rejects ambiguous matches instead of depending on fixture order", async () => {
    const op = multi.operations[0]!;
    const server = await start({ version: 2, operations: [op, { ...op, id: "duplicate-route" }] });
    expect(
      await (await server.post("/v1/ocr", { model: "ocr", document: { type: "image_url" } }))
        .json(),
    ).toEqual({ error: "ambiguous_match" });
  });

  it("supports generic JSON status/headers and named SSE events", async () => {
    const server = await start({
      version: 2,
      operations: [
        {
          id: "error",
          operation: "generic",
          method: "GET",
          path: "/error",
          expect: {},
          response: {
            kind: "json",
            timing: { response_delay_ms: 0 },
            status: 429,
            headers: { "retry-after": "1" },
            body: { error: "rate_limit" },
          },
        },
        {
          id: "events",
          operation: "generic",
          method: "GET",
          path: "/events",
          expect: {},
          response: {
            kind: "sse",
            timing: { first_event_delay_ms: 0, event_interval_ms: 0 },
            events: [{ event: "custom", data: { ok: true } }],
          },
        },
      ],
    });
    const error = await server.get("/error");
    expect(error.status).toBe(429);
    expect(error.headers.get("retry-after")).toBe("1");
    expect(await error.json()).toEqual({ error: "rate_limit" });
    expect(await (await server.get("/events")).text()).toBe(
      "event: custom\ndata: {\"ok\":true}\n\n",
    );
    expect((await server.stats()).failures).toBe(0);
  });

  it("streams incrementally and cancels long streams independently", async () => {
    const server = await start({
      version: 2,
      operations: [
        chatCompletion({
          id: "slow",
          model: "bench",
          chunks: ["one", "two"],
          stream: true,
          timing: { firstEventDelayMs: 0, eventIntervalMs: 60_000 },
        }),
        multi.operations[0]!,
      ],
    });
    const controllers = [new AbortController(), new AbortController()];
    await Promise.all(controllers.map(async (controller) => {
      const response = await server.post(
        "/v1/chat/completions",
        { model: "bench", stream: true },
        controller.signal,
      );
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("\"role\":\"assistant\"");
      expect(first.done).toBe(false);
      controller.abort();
      await reader.cancel().catch(() => {});
    }));
    await expect.poll(async () => (await server.stats()).streams.cancelled).toBe(2);
    expect((await server.stats()).streams.completed).toBe(0);
    expect(
      (await server.post("/v1/ocr", {
        model: "ocr",
        document: {
          type: "image_url",
          image_url:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        },
      })).status,
    ).toBe(200);
  });

  it("closes its scope while a stream is sleeping", async () => {
    const server = await start({
      version: 2,
      operations: [
        chatCompletion({
          id: "shutdown",
          model: "bench",
          chunks: ["x"],
          stream: true,
          timing: { firstEventDelayMs: 0, eventIntervalMs: 60_000 },
        }),
      ],
    });
    const response = await server.post("/v1/chat/completions", { model: "bench", stream: true });
    const reader = response.body!.getReader();
    await reader.read();
    await Effect.runPromise(Scope.close(server.scope, Exit.void));
    expect((await reader.read()).done).toBe(true);
  });

  it("strictly validates fixtures and explicit response timing", () => {
    expect(validateFixture(single)).toEqual(single);
    expect(validateFixture(multi)).toEqual(multi);
    for (
      const fixture of [
        { method: "POST", path: "/v1/test", expect: {}, response: {} },
        { ...single, typo: true },
        { version: 2, operations: [] },
        { version: 2, operations: [multi.operations[0], multi.operations[0]] },
        {
          version: 2,
          operations: [{
            ...multi.operations[0],
            response: { kind: "json", body: {} },
          }],
        },
        {
          version: 2,
          operations: [{
            ...multi.operations[0],
            response: { kind: "sse", events: [{ data: "[DONE]" }] },
          }],
        },
        {
          version: 2,
          operations: [{
            ...multi.operations[0],
            response: {
              kind: "sse",
              timing: { first_event_delay_ms: 0, event_interval_ms: -1 },
              events: [],
            },
          }],
        },
        {
          version: 2,
          operations: [{
            ...multi.operations[0],
            response: {
              kind: "json",
              timing: { response_delay_ms: 0 },
              body: {},
              headers: { "Content-Length": "1" },
            },
          }],
        },
        { version: 2, operations: [{ ...multi.operations[0], path: "/__stats" }] },
      ]
    ) expect(() => validateFixture(fixture)).toThrow();
  });
});

it.effect("paces the first and subsequent events using the Effect clock", () =>
  Effect.gen(function*() {
    const seen = yield* Ref.make<number[]>([]);
    const fiber = yield* pacedStream(
      [new Uint8Array([1]), new Uint8Array([2])],
      { first_event_delay_ms: 100, event_interval_ms: 50 },
    ).pipe(
      Stream.runForEach((bytes) => Ref.update(seen, (values) => [...values, bytes[0]!])),
      Effect.forkChild,
    );
    yield* TestClock.adjust(99);
    expect(yield* Ref.get(seen)).toEqual([]);
    yield* TestClock.adjust(1);
    expect(yield* Ref.get(seen)).toEqual([1]);
    yield* TestClock.adjust(49);
    expect(yield* Ref.get(seen)).toEqual([1]);
    yield* TestClock.adjust(1);
    yield* Fiber.join(fiber);
    expect(yield* Ref.get(seen)).toEqual([1, 2]);
  }));
