# Mock provider

Deterministic replay host for proxy benchmarks. One process can serve provider-route fixtures with
JSON or SSE responses while validating incoming requests.

```sh
pnpm --filter @litellm-bench/mock-provider... build
MOCK_FIXTURE=packages/provider-openai-chat-completions/fixtures/streaming.json \
  node apps/mock-provider/dist/main.js
curl -N http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"bench-model","stream":true}'
```

`MOCK_PORT` defaults to `8080`. The server binds to `0.0.0.0`.
`dist/main.js` bundles runtime dependencies and runs with Node 24+ without `node_modules`, including
inside the existing Docker mount. SIGINT/SIGTERM close the server scope and interrupt active requests.

## Fixtures

Fixtures use version 2 with named operations and explicit response timing:

```json
{
  "version": 2,
  "operations": [
    {
      "id": "custom-events",
      "operation": "generic",
      "method": "POST",
      "path": "/v1/custom",
      "expect": { "model": "bench-model", "stream": true },
      "response": {
        "kind": "sse",
        "timing": {
          "first_event_delay_ms": 100,
          "event_interval_ms": 25
        },
        "events": [
          { "event": "delta", "data": { "text": "Hello" } },
          { "event": "complete", "data": { "ok": true } }
        ]
      }
    }
  ]
}
```

- Matching uses exact method and request URL (including any query), object subsets, and exact arrays.
  `optional_expect` checks a top-level key only when the request contains it. `body_match: "exact"`
  rejects top-level fields outside `expect`, `optional_expect`, and dynamic `png_fields`; its default is
  `"subset"`. Use `expect.stream: true` for streaming and `optional_expect.stream: false` for
  non-streaming variants. Multiple matches reject with `ambiguous_match`; fixture order is never a
  tie-breaker.
- `png_fields` checks PNG signatures at dot-separated request paths, preserving existing OCR behavior.
- JSON responses declare `timing: { "response_delay_ms": 0 }`; zero-delay behavior is never inherited.
  SSE responses declare both `first_event_delay_ms` and `event_interval_ms`. The fixture is the only
  timing source, and all timing uses milliseconds. Both response kinds support `status` and `headers`.
  Status defaults to 200; content type and HTTP framing headers belong to the transport. Simulated
  429/500 responses are valid matches, not validation failures.
- `first_event_delay_ms` applies before the first event and `event_interval_ms` between subsequent
  events. There is no delay after the final event. SSE strings are sent
  literally (including `[DONE]`); other data values are JSON encoded. Events flush incrementally with
  backpressure, and disconnects interrupt pending delays.
- Fixture decoding, semantic checks, types, and JSON Schema share `packages/contracts/src/proxy.ts`.
  Unknown fixture fields, duplicate IDs, reserved `/__stats` paths, invalid timing, and framing-header
  overrides reject at startup and proxy preflight.

## Operation builders

`@litellm-bench/mock-provider/operations` currently exports the Responses builder. Provider-route
packages own provider-specific builders and canonical fixture data; Mistral OCR and OpenAI Chat
Completions live in their respective `@litellm-bench/provider-*` packages. Every builder produces the
same version 2 replay format:

```ts
import { responses } from "@litellm-bench/mock-provider/operations";
import { openAiChatCompletion } from "@litellm-bench/provider-openai-chat-completions";

const fixture = {
  version: 2,
  operations: [
    openAiChatCompletion({
      id: "chat-stream",
      model: "bench-model",
      chunks: ["Hello", " world"],
      stream: true,
      timing: { firstEventDelayMs: 0, eventIntervalMs: 25 },
      includeUsage: true,
    }),
    responses({
      id: "response",
      model: "bench-model",
      chunks: ["Hello world"],
      timing: { responseDelayMs: 0 },
    }),
  ],
};
```

Chat emits role/content deltas, a stop chunk, optional usage, and `[DONE]`. Responses emits named
lifecycle events with ordered sequence numbers, output-item/content-part events, text deltas, and
`response.completed`. JSON and streaming builders share the same text and usage model. IDs and
creation timestamps are fixed. Usage is synthetic, configurable with `{ input, output }`; chunk
boundaries are not tokenizer output. `includeUsage` controls the fixture, not request negotiation;
use `expect.stream_options` when that request field needs validation.

The `operation` field labels the protocol. Builders supply protocol behavior; the engine faithfully
replays explicit JSON/SSE fixtures. Use `generic` for new endpoints, and explicit events for tool calls,
errors, or other payloads. These are text-generation fixtures, not a stateful implementation of all
Responses endpoints.

## Effect runtime and statistics

`createMockServer(fixture, options)` returns a scoped Effect. Provide a scope with `Effect.scoped` and
keep it open while serving; the returned HTTP server includes its bound address. Unlike the previous
Node helper, this function acquires and starts the server itself.

`OperationRegistry` and `Statistics` use `Context.Service`/`Layer`; payloads are compiled once.
HTTP uses Effect's router and Node server, pacing uses `Stream`/`Effect.sleep`, and cancellation follows
the request scope. Matching and protocol encoding remain pure functions.

`GET /__stats` is excluded from request counts. Legacy fields remain `requests`, `failures`, and
`errors`. Once a stream starts, `streams` adds `started`, `completed`, `cancelled`, and `failed` counts.
Completion means the producer finished emitting its events, not that the remote application consumed
them. Validation failures and stream outcomes are separate. JSON-only stats retain their old shape.

The existing k6 workload remains JSON-oriented. Streaming client benchmarks, TTFT, and inter-token
measurements require a separate workload/client extension.

```sh
pnpm --filter @litellm-bench/mock-provider test
pnpm --filter @litellm-bench/contracts schema:check
```

Tests cover explicit timing, protocol streams, pacing with Effect TestClock, concurrent cancellations,
shutdown, strict decoding, generic responses, and ambiguous routes.
