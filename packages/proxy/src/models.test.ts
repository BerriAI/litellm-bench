import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { parseTimeTelemetry, rateParts } from "./k6.js";
import { K6WorkloadDefinition, telemetryMeasurements } from "./models.js";

describe("k6 load configuration", () => {
  it("represents fractional rates without rounding the offered load", () => {
    expect(rateParts(3)).toEqual([3, "1s"]);
    expect(rateParts(2.5)).toEqual([5, "2s"]);
    expect(rateParts(0.125)).toEqual([1, "8s"]);
  });

  it("parses pinned load-generator utilization without consuming the retained log", () => {
    expect(parseTimeTelemetry(
      "k6 diagnostic\nLITELLM_BENCH_TIME cpu_percent=42% user_seconds=1.25 system_seconds=0.5 max_rss_kib=1234\n",
      "2",
    )).toEqual({
      cpuPercent: 42,
      userSeconds: 1.25,
      systemSeconds: 0.5,
      maxRssKib: 1234,
      cpuSet: "2",
    });
  });

  it("strictly validates declarative HTTP workloads", () => {
    const decode = Schema.decodeUnknownSync(K6WorkloadDefinition, { onExcessProperty: "error" });
    expect(
      decode({
        request: { method: "POST", path: "/v1/test", headers: {} },
        response: {
          status: 200,
          jsonEquals: [{ path: ["items", 0, "id"], value: "expected" }],
        },
      }).response.jsonEquals[0]?.path,
    ).toEqual(["items", 0, "id"]);
    expect(() =>
      decode({
        request: { method: "POST", path: "v1/test", headers: {} },
        response: { status: 700, jsonEquals: [] },
      })
    ).toThrow();
    expect(
      decode({
        request: { method: "POST", path: "/v1/chat/completions", headers: {} },
        response: {
          status: 200,
          jsonEquals: [],
          sse: {
            event_count: 2,
            terminal_data: "[DONE]",
            jsonEquals: [{ index: 0, path: ["choices", 0, "delta", "content"], value: "hi" }],
          },
        },
      }).response.sse?.terminal_data,
    ).toBe("[DONE]");
  });
});

describe("container telemetry projection", () => {
  it("converts byte counters and CPU time without changing the measurement window", () => {
    expect(telemetryMeasurements({
      imageId: "sha256:image",
      baselineMemoryBytes: 1_048_576,
      baselineAnonBytes: 2_097_152,
      peakMemoryBytes: 3_145_728,
      loadedMemoryBytes: 4_194_304,
      loadedAnonBytes: 5_242_880,
      idleMemoryBytes: 6_291_456,
      idleAnonBytes: 7_340_032,
      cpuBeforeUsec: 1_000_000,
      cpuAfterUsec: 2_500_000,
      cpuNrPeriodsBefore: 1,
      cpuNrPeriodsAfter: 2,
      cpuNrThrottledBefore: 0,
      cpuNrThrottledAfter: 0,
      cpuThrottledUsecBefore: 0,
      cpuThrottledUsecAfter: 0,
      cpuMax: "100000 100000",
      cpuSet: "0",
      wallSeconds: 3,
      window: "k6 process: initialization, warmup, measurement, and drain",
    })).toEqual({
      cpuAveragePercent: 50,
      baselineMemoryMib: 1,
      baselineAnonMib: 2,
      peakMemoryMib: 3,
      loadedMemoryMib: 4,
      loadedAnonMib: 5,
      idleMemoryMib: 6,
      idleAnonMib: 7,
    });
  });
});
