import { describe, expect, it } from "vitest";
import { parseK6Result } from "./k6.js";

const result = {
  started: 0,
  completed: 0,
  successful: 0,
  failed: 0,
  dropped: 0,
  interrupted: 0,
  window_completed: 0,
  window_successful: 0,
  window_failed: 0,
  tail_completed: 0,
  tail_successful: 0,
  tail_failed: 0,
  warmup_requests: 0,
  warmup_failed: 0,
  measurement_seconds: 1,
  drain_seconds: 0,
  elapsed_seconds: 1,
  completion_rps: 0,
  error_rate: 0,
  warmup_stable: true,
  warmup_cv: null,
  warmup_window_rps: [],
  latency: null,
  ttfb: null,
  errors: {},
};

describe("parseK6Result", () => {
  it("omits unavailable optional metrics reported as null", () => {
    const parsed = parseK6Result(JSON.stringify(result));
    expect(parsed).toHaveProperty("result");
    expect(parsed.result).not.toHaveProperty("warmup_cv");
    expect(parsed.result).not.toHaveProperty("latency");
    expect(parsed.result).not.toHaveProperty("ttfb");
  });
});
