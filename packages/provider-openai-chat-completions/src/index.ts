import type {
  JsonRecord,
  MockOperation,
  ProviderRouteManifest,
  SseEvent,
  UpstreamFixture,
} from "@litellm-bench/contracts";
import { fileURLToPath } from "node:url";

interface ChatCompletionBase {
  readonly id: string;
  readonly responseId?: string;
  readonly model: string;
  readonly chunks: readonly string[];
  readonly expect?: JsonRecord;
  readonly expectHeaders?: Readonly<Record<string, string>>;
  readonly bodyMatch?: "subset" | "exact";
  readonly usage?: { readonly input: number; readonly output: number };
}

export type OpenAiChatCompletionOptions =
  & ChatCompletionBase
  & (
    | {
      readonly stream: true;
      readonly includeUsage?: boolean;
      readonly maxWriteBytes?: number;
      readonly timing: {
        readonly firstEventDelayMs: number;
        readonly eventIntervalMs: number;
      };
    }
    | {
      readonly stream?: false;
      readonly timing: { readonly responseDelayMs: number };
    }
  );

/** A synthetic OpenAI Chat Completions exchange in the shared replay format. */
export const openAiChatCompletion = (options: OpenAiChatCompletionOptions): MockOperation => {
  const id = options.responseId ?? `chatcmpl-${options.id}`;
  const base = { id, created: 1, model: options.model };
  const input = options.usage?.input ?? 1;
  const output = options.usage?.output ?? options.chunks.length;
  const usage = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
  const chunk = (delta: JsonRecord, finish_reason: string | null = null): SseEvent => ({
    data: {
      ...base,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason }],
    },
  });
  return {
    id: options.id,
    operation: "chat-completions",
    method: "POST",
    path: "/v1/chat/completions",
    expect: {
      ...options.expect,
      model: options.model,
      ...(options.stream ? { stream: true } : {}),
    },
    ...(options.stream ? {} : { optional_expect: { stream: false } }),
    ...(options.bodyMatch === undefined ? {} : { body_match: options.bodyMatch }),
    ...(options.expectHeaders === undefined ? {} : { expect_headers: options.expectHeaders }),
    response: options.stream
      ? {
        kind: "sse",
        ...(options.maxWriteBytes === undefined ? {} : { max_write_bytes: options.maxWriteBytes }),
        timing: {
          first_event_delay_ms: options.timing.firstEventDelayMs,
          event_interval_ms: options.timing.eventIntervalMs,
        },
        events: [
          chunk({ role: "assistant", content: "" }),
          ...options.chunks.map((content) => chunk({ content })),
          chunk({}, "stop"),
          ...(options.includeUsage
            ? [{ data: { ...base, object: "chat.completion.chunk", choices: [], usage } }]
            : []),
          { data: "[DONE]" },
        ],
      }
      : {
        kind: "json",
        timing: { response_delay_ms: options.timing.responseDelayMs },
        body: {
          ...base,
          object: "chat.completion",
          choices: [{
            index: 0,
            message: { role: "assistant", content: options.chunks.join("") },
            finish_reason: "stop",
          }],
          usage,
        },
      },
  };
};

export const openAiChatCompletionsFixture = (
  options: OpenAiChatCompletionOptions,
): UpstreamFixture => ({ version: 2, operations: [openAiChatCompletion(options)] });

const canonicalChunks = [
  "Here",
  "'s",
  " a",
  " deliberately",
  " fragmented",
  " response",
  ".",
  "\n\n",
  "It includes ",
  "\"quoted text\"",
  ", backslashes \\\\",
  ", JSON: ",
  "{\"ok\":true,\"items\":[1,2,3]}",
  ", Unicode: ",
  "café ",
  "東京 ",
  "🙂",
  ".\n",
  "Markdown:\n",
  "- first item\n",
  "- second item\n",
  "```ts\n",
  "const value = \"streamed\";\n",
  "```\n",
  "Large block follows:\n",
  "x".repeat(8_192),
  "\nEnd.",
] as const;

export const canonicalOpenAiChatCompletions = {
  model: "bench-model",
  messages: [{ role: "user", content: "Hello" }],
  streamOptions: { include_usage: true },
  headers: {
    authorization: "Bearer sk-mock",
    "content-type": "application/json",
  },
  response: canonicalChunks.join(""),
  streamingChunks: canonicalChunks,
  totalTokens: 2_060,
  usage: { input: 12, output: 2_048 },
} as const;

export const canonicalOpenAiStreamingEventCount =
  canonicalOpenAiChatCompletions.streamingChunks.length + 4;
export const canonicalOpenAiChatCompletionsResponseBytes = new TextEncoder().encode(
  canonicalOpenAiChatCompletions.response,
).byteLength;
export const canonicalOpenAiStreamingMaxWriteBytes = 64;

const conformanceRequest = (caseId: string) => ({
  model: canonicalOpenAiChatCompletions.model,
  messages: [{ role: "user", content: `conformance:${caseId}` }],
});
const conformanceResponse = (caseId: string, body: JsonRecord, status = 200): MockOperation => ({
  id: `conformance-${caseId}`,
  operation: "chat-completions",
  method: "POST",
  path: "/v1/chat/completions",
  expect: conformanceRequest(caseId),
  optional_expect: { stream: false },
  body_match: "exact",
  response: { kind: "json", status, timing: { response_delay_ms: 0 }, body },
});

/** Shape coverage kept separate from the high-volume capacity fixtures. */
export const canonicalOpenAiChatCompletionsConformanceFixture: UpstreamFixture = {
  version: 2,
  operations: [
    conformanceResponse("short-text", {
      id: "chatcmpl-short",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    conformanceResponse("multiple-choices", {
      id: "chatcmpl-multi",
      object: "chat.completion",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "first" },
        finish_reason: "stop",
      }, { index: 1, message: { role: "assistant", content: "second" }, finish_reason: "length" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }),
    conformanceResponse("tool-call", {
      id: "chatcmpl-tool",
      object: "chat.completion",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: "{\"city\":\"東京\"}" },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
    }),
    conformanceResponse("refusal", {
      id: "chatcmpl-refusal",
      object: "chat.completion",
      choices: [{
        index: 0,
        message: { role: "assistant", content: null, refusal: "Cannot comply." },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }),
    conformanceResponse("empty-content", {
      id: "chatcmpl-empty",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
    conformanceResponse("provider-error", {
      error: {
        message: "synthetic rate limit",
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      },
    }, 429),
  ],
};

export const canonicalOpenAiChatCompletionsFixturePath = fileURLToPath(
  import.meta.resolve("@litellm-bench/provider-openai-chat-completions/fixture"),
);

export const canonicalOpenAiStreamingChatCompletionsFixturePath = fileURLToPath(
  import.meta.resolve("@litellm-bench/provider-openai-chat-completions/fixture-streaming"),
);

export const canonicalOpenAiChatCompletionsConformanceFixturePath = fileURLToPath(
  import.meta.resolve("@litellm-bench/provider-openai-chat-completions/fixture-conformance"),
);

export const openAiChatCompletionsManifest = {
  version: 1,
  provider: "openai",
  route: "/v1/chat/completions",
  fixtures: [
    {
      id: "canonical-nonstream",
      export: "./fixture",
      purpose: "capacity",
      modes: ["json"],
      provenance: { source: "synthetic", generator: "scripts/generate-fixtures.mjs" },
    },
    {
      id: "canonical-streaming",
      export: "./fixture-streaming",
      purpose: "capacity",
      modes: ["sse"],
      provenance: { source: "synthetic", generator: "scripts/generate-fixtures.mjs" },
    },
    {
      id: "conformance",
      export: "./fixture-conformance",
      purpose: "conformance",
      modes: ["json"],
      provenance: { source: "synthetic", generator: "scripts/generate-fixtures.mjs" },
    },
  ],
} as const satisfies ProviderRouteManifest;
