import type { ProxyRawObservation } from "@litellm-bench/contracts";
import { describe, expect, it } from "vitest";
import { proxyTrialIntegrityIssue, proxyTrialIssue } from "./validation.js";

const trial = (): ProxyRawObservation["trials"][number] => ({
  id: "trial",
  scenario: "scenario",
  variant: "default",
  round: 1,
  load: { mode: "closed", concurrency: 1, duration_seconds: 1, warmup_seconds: 0 },
  dimensions: {},
  client: {
    engine: "k6",
    exit_code: 0,
    artifacts: {},
    result: {
      started: 2,
      completed: 2,
      successful: 2,
      failed: 0,
      dropped: 0,
      interrupted: 0,
      window_completed: 2,
      window_successful: 2,
      window_failed: 0,
      tail_completed: 0,
      tail_successful: 0,
      tail_failed: 0,
      warmup_requests: 1,
      warmup_failed: 0,
      measurement_seconds: 1,
      drain_seconds: 0,
      elapsed_seconds: 1,
      completion_rps: 2,
      error_rate: 0,
      errors: {},
    },
  },
  upstream: { requests: 3, failures: 0, errors: {} },
});

describe("proxy trial validity", () => {
  it("accepts reconciled successful traffic", () =>
    expect(proxyTrialIssue(trial())).toBeUndefined());
  it("rejects unsuccessful streams separately from validation failures", () => {
    for (
      const streams of [
        { started: 1, completed: 0, failed: 1, cancelled: 0 },
        { started: 1, completed: 0, failed: 0, cancelled: 1 },
        { started: 1, completed: 0, failed: 0, cancelled: 0 },
      ]
    ) {
      expect(proxyTrialIssue({ ...trial(), upstream: { ...trial().upstream!, streams } }))
        .toBe("upstream streams failed, cancelled, or incomplete");
    }
    expect(proxyTrialIssue({
      ...trial(),
      upstream: {
        ...trial().upstream!,
        streams: {
          started: 3,
          completed: 3,
          failed: 0,
          cancelled: 0,
        },
      },
    })).toBeUndefined();
  });
  it("reports infrastructure, client, response, and upstream failures precisely", () => {
    expect(proxyTrialIssue({ ...trial(), error: "startup failed" })).toBe("startup failed");
    expect(
      proxyTrialIssue({
        ...trial(),
        client: { ...trial().client!, exit_code: 1, error: "load failed" },
      }),
    ).toBe("load failed");
    expect(proxyTrialIssue({ ...trial(), upstream: { requests: 2, failures: 0, errors: {} } }))
      .toBe("client and upstream request counts differ");
  });
  it("retains dropped arrivals as saturation evidence in integrity-only sweeps", () => {
    const saturated = {
      ...trial(),
      client: {
        ...trial().client!,
        result: { ...trial().client!.result!, dropped: 3 },
      },
    };
    expect(proxyTrialIssue(saturated)).toMatch(/dropped/);
    expect(proxyTrialIntegrityIssue(saturated)).toBeUndefined();
  });
});
