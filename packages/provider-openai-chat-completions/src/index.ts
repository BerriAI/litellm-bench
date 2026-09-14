import type {
  JsonRecord,
  MockOperation,
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

export const canonicalOpenAiChatCompletionsFixturePath = fileURLToPath(
  import.meta.resolve("@litellm-bench/provider-openai-chat-completions/fixture"),
);

export const canonicalOpenAiStreamingChatCompletionsFixturePath = fileURLToPath(
  import.meta.resolve("@litellm-bench/provider-openai-chat-completions/fixture-streaming"),
);
