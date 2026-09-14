import type {
  JsonRecord,
  MockOperation,
  ProviderRouteManifest,
  UpstreamFixture,
} from "@litellm-bench/contracts";
import { fileURLToPath } from "node:url";

interface TextOperationBase {
  readonly id: string;
  readonly model: string;
  readonly chunks: readonly string[];
  readonly expect?: JsonRecord;
  readonly path?: `/${string}`;
  readonly usage?: { readonly input: number; readonly output: number };
}

export type OpenAiResponseOptions =
  & TextOperationBase
  & (
    | {
      readonly stream: true;
      readonly timing: { readonly firstEventDelayMs: number; readonly eventIntervalMs: number };
    }
    | { readonly stream?: false; readonly timing: { readonly responseDelayMs: number } }
  );

/** A synthetic text-only OpenAI Responses exchange in the shared replay format. */
export const openAiResponse = (options: OpenAiResponseOptions): MockOperation => {
  const id = `resp_${options.id}`;
  const itemId = `msg_${options.id}`;
  const text = options.chunks.join("");
  const content = { type: "output_text", text, annotations: [], logprobs: [] };
  const item = {
    id: itemId,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [content],
  };
  const input = options.usage?.input ?? 1;
  const output = options.usage?.output ?? options.chunks.length;
  const base = {
    id,
    object: "response",
    created_at: 1,
    model: options.model,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    parallel_tool_calls: true,
    temperature: 1,
    tool_choice: "auto",
    tools: [],
    top_p: 1,
  };
  const completed = {
    ...base,
    status: "completed",
    output: [item],
    usage: {
      input_tokens: input,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: output,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: input + output,
    },
  };
  const pending = { ...base, status: "in_progress", output: [], usage: null };
  const location = { item_id: itemId, output_index: 0, content_index: 0 };
  const events: readonly JsonRecord[] = [
    { type: "response.created", response: pending },
    { type: "response.in_progress", response: pending },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    { type: "response.content_part.added", ...location, part: { ...content, text: "" } },
    ...options.chunks.map((delta) => ({
      type: "response.output_text.delta",
      ...location,
      delta,
      logprobs: [],
    })),
    { type: "response.output_text.done", ...location, text, logprobs: [] },
    { type: "response.content_part.done", ...location, part: content },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: completed },
  ];
  return {
    id: options.id,
    operation: "responses",
    method: "POST",
    path: options.path ?? "/v1/responses",
    expect: {
      ...options.expect,
      model: options.model,
      ...(options.stream ? { stream: true } : {}),
    },
    ...(options.stream ? {} : { optional_expect: { stream: false } }),
    response: options.stream
      ? {
        kind: "sse",
        timing: {
          first_event_delay_ms: options.timing.firstEventDelayMs,
          event_interval_ms: options.timing.eventIntervalMs,
        },
        events: events.map((data, sequence_number) => ({
          event: String(data.type),
          data: { ...data, sequence_number },
        })),
      }
      : {
        kind: "json",
        timing: { response_delay_ms: options.timing.responseDelayMs },
        body: completed,
      },
  };
};

export const openAiResponsesFixture = (options: OpenAiResponseOptions): UpstreamFixture => ({
  version: 2,
  operations: [openAiResponse(options)],
});

export const canonicalOpenAiResponse = {
  model: "bench-model",
  chunks: ["Hello", " ", "from Responses", " 🙂"],
} as const;
export const canonicalOpenAiResponseFixturePath = fileURLToPath(
  import.meta.resolve("@litellm-bench/provider-openai-responses/fixture"),
);
export const canonicalOpenAiStreamingResponseFixturePath = fileURLToPath(
  import.meta.resolve("@litellm-bench/provider-openai-responses/fixture-streaming"),
);

export const openAiResponsesManifest = {
  version: 1,
  provider: "openai",
  route: "/v1/responses",
  fixtures: [
    {
      id: "canonical-nonstream",
      export: "./fixture",
      purpose: "conformance",
      modes: ["json"],
      provenance: { source: "synthetic", generator: "scripts/generate-fixtures.mjs" },
    },
    {
      id: "canonical-streaming",
      export: "./fixture-streaming",
      purpose: "conformance",
      modes: ["sse"],
      provenance: { source: "synthetic", generator: "scripts/generate-fixtures.mjs" },
    },
  ],
} as const satisfies ProviderRouteManifest;
