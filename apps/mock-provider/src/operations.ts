import type { JsonRecord, MockOperation, SseEvent } from "@litellm-bench/contracts";

interface TextOperationBase {
  readonly id: string;
  readonly model: string;
  readonly chunks: readonly string[];
  readonly includeUsage?: boolean;
  readonly expect?: JsonRecord;
  readonly path?: `/${string}`;
  readonly usage?: { readonly input: number; readonly output: number };
}

export type TextOperationOptions =
  & TextOperationBase
  & (
    | {
      readonly stream: true;
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

const matcher = (options: TextOperationOptions) => ({
  expect: { ...options.expect, model: options.model, ...(options.stream ? { stream: true } : {}) },
  ...(options.stream ? {} : { optional_expect: { stream: false } }),
});

/** Deterministic OpenAI-compatible chat text fixture, including the optional usage chunk. */
export const chatCompletion = (options: TextOperationOptions): MockOperation => {
  const id = `chatcmpl-${options.id}`;
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
    path: options.path ?? "/v1/chat/completions",
    ...matcher(options),
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

/** Text-only Responses lifecycle. Explicit SSE fixtures can model tools and other event types. */
export const responses = (options: TextOperationOptions): MockOperation => {
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
    ...matcher(options),
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

export const ocr = (options: {
  readonly id: string;
  readonly model: string;
  readonly markdown: string;
  readonly timing: { readonly responseDelayMs: number };
}): MockOperation => ({
  id: options.id,
  operation: "ocr",
  method: "POST",
  path: "/v1/ocr",
  expect: { model: options.model, document: { type: "image_url" } },
  png_fields: ["document.image_url"],
  response: {
    kind: "json",
    timing: { response_delay_ms: options.timing.responseDelayMs },
    body: {
      model: options.model,
      pages: [{ index: 0, markdown: options.markdown, images: [] }],
      usage_info: { pages_processed: 1 },
    },
  },
});
