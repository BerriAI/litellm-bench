import { describe, expect, it } from "vitest";

// @ts-expect-error The plain JS module is copied directly into the k6 runtime.
import { matchesSseResponse, parseSseData } from "../assets/response.js";

describe("SSE response validation", () => {
  const body =
    "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\r\n\r\ndata: [DONE]\r\n\r\n";

  it("parses CRLF frames and validates semantic checks", () => {
    expect(parseSseData(body)).toEqual([
      { choices: [{ delta: { content: "hello" } }] },
      "[DONE]",
    ]);
    expect(parseSseData("data: plain text\n\n")).toEqual(["plain text"]);
    expect(matchesSseResponse(body, {
      event_count: 2,
      terminal_data: "[DONE]",
      jsonEquals: [{ index: 0, path: ["choices", 0, "delta", "content"], value: "hello" }],
    })).toBe(true);
  });

  it("rejects malformed, incomplete, and semantically incorrect streams", () => {
    const expectation = { event_count: 2, terminal_data: "[DONE]", jsonEquals: [] };
    expect(matchesSseResponse("event: empty\n\n", expectation)).toBe(false);
    expect(matchesSseResponse("data: {\"ok\":true}\n\n", expectation)).toBe(false);
    expect(matchesSseResponse(body, { ...expectation, terminal_data: "finished" })).toBe(false);
  });
});
