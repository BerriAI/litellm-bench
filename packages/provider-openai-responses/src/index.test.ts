import { decodeProviderRouteManifest, decodeUpstreamFixture } from "@litellm-bench/contracts";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalOpenAiResponseFixturePath,
  canonicalOpenAiStreamingResponseFixturePath,
  openAiResponse,
  openAiResponsesManifest,
} from "./index.js";

describe("OpenAI Responses fixtures", () => {
  it("builds non-streaming and streaming response lifecycles", () => {
    const plain = openAiResponse({
      id: "plain",
      model: "bench",
      chunks: ["a", "b"],
      timing: { responseDelayMs: 0 },
    });
    const stream = openAiResponse({
      id: "stream",
      model: "bench",
      chunks: ["a", "b"],
      stream: true,
      timing: { firstEventDelayMs: 0, eventIntervalMs: 0 },
    });
    expect(plain.response.kind).toBe("json");
    expect(stream.response.kind).toBe("sse");
    if (stream.response.kind === "sse") {
      expect(stream.response.events.map(({ event }) => event)).toContain("response.completed");
    }
    expect(decodeProviderRouteManifest(openAiResponsesManifest).route).toBe("/v1/responses");
    expect(decodeUpstreamFixture(JSON.parse(
      readFileSync(canonicalOpenAiResponseFixturePath, "utf8"),
    ))).toHaveLength(1);
    expect(decodeUpstreamFixture(JSON.parse(
      readFileSync(canonicalOpenAiStreamingResponseFixturePath, "utf8"),
    ))).toHaveLength(1);
  });
});
