import { decodeUpstreamFixture } from "@litellm-bench/contracts";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalOpenAiChatCompletions,
  canonicalOpenAiChatCompletionsFixturePath,
  canonicalOpenAiStreamingChatCompletionsFixturePath,
  openAiChatCompletionsFixture,
} from "./index.js";

const canonicalOptions = {
  model: canonicalOpenAiChatCompletions.model,
  expectHeaders: canonicalOpenAiChatCompletions.headers,
  bodyMatch: "exact" as const,
};

describe("OpenAI Chat Completions provider contract", () => {
  it("keeps the canonical JSON fixture equivalent to its synthetic source", () => {
    const fixture = JSON.parse(readFileSync(canonicalOpenAiChatCompletionsFixturePath, "utf8"));
    expect(decodeUpstreamFixture(fixture)).toEqual(
      openAiChatCompletionsFixture({
        ...canonicalOptions,
        expect: { messages: canonicalOpenAiChatCompletions.messages },
        id: "nonstream-chat-completion",
        responseId: "chatcmpl-mock",
        chunks: [canonicalOpenAiChatCompletions.response],
        usage: canonicalOpenAiChatCompletions.usage,
        timing: { responseDelayMs: 0 },
      }).operations,
    );
  });

  it("keeps the canonical SSE fixture equivalent to its synthetic source", () => {
    const fixture = JSON.parse(
      readFileSync(canonicalOpenAiStreamingChatCompletionsFixturePath, "utf8"),
    );
    expect(decodeUpstreamFixture(fixture)).toEqual(
      openAiChatCompletionsFixture({
        ...canonicalOptions,
        expect: {
          messages: canonicalOpenAiChatCompletions.messages,
          stream_options: canonicalOpenAiChatCompletions.streamOptions,
        },
        id: "chat-stream",
        responseId: "chatcmpl-stream",
        chunks: canonicalOpenAiChatCompletions.streamingChunks,
        usage: canonicalOpenAiChatCompletions.usage,
        stream: true,
        includeUsage: true,
        timing: { firstEventDelayMs: 10, eventIntervalMs: 1 },
      }).operations,
    );
  });
});
