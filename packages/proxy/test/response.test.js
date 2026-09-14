import { describe, expect, it } from "vitest";

import { matchesJsonChecks } from "../assets/response.js";

describe("k6 response checks", () => {
  const response = {
    object: "chat.completion",
    choices: [{ message: { role: "assistant" } }],
    usage: { tokens: [1, 2] },
  };

  it("matches scalar and structural values at object and array paths", () => {
    expect(matchesJsonChecks(response, [
      { path: ["object"], value: "chat.completion" },
      { path: ["choices", 0, "message", "role"], value: "assistant" },
      { path: ["usage"], value: { tokens: [1, 2] } },
    ])).toBe(true);
  });

  it("rejects missing paths and unequal values", () => {
    expect(matchesJsonChecks(response, [{ path: ["choices", 1], value: null }])).toBe(false);
    expect(matchesJsonChecks(response, [{ path: ["usage", "tokens"], value: [2, 1] }])).toBe(
      false,
    );
  });
});
