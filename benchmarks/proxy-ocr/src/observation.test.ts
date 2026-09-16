import type { ProxyRawObservation } from "@litellm-bench/contracts";
import { Effect } from "effect";
import { expect, it } from "vitest";
import type { OcrIntegrity } from "./config.js";
import { classifyOcrTrial, decodeOcrObservation } from "./observation.js";

const integrity: OcrIntegrity = {
  proxy_cpu_min_percent: 90,
  mock_cpu_max_percent: 80,
  load_generator_cpu_max_percent: 160,
};

const classify = (candidate: ProxyRawObservation["trials"][number]) =>
  classifyOcrTrial(candidate, integrity);

const trial = (
  overrides: Partial<ProxyRawObservation["trials"][number]> = {},
): ProxyRawObservation["trials"][number] => ({
  id: "core_python_r1",
  scenario: "core",
  variant: "python",
  round: 1,
  load: { mode: "closed", concurrency: 2, duration_seconds: 1, warmup_seconds: 0 },
  dimensions: {
    payload_requested_bytes: 1,
    wire_body_bytes: 100,
    document_bytes: 68,
    document_sha256: "a".repeat(64),
  },
  client: {
    engine: "k6",
    exit_code: 0,
    artifacts: {},
    result: {
      started: 10,
      completed: 10,
      successful: 10,
      failed: 0,
      dropped: 0,
      interrupted: 0,
      window_completed: 10,
      window_successful: 10,
      window_failed: 0,
      tail_completed: 0,
      tail_successful: 0,
      tail_failed: 0,
      warmup_requests: 0,
      warmup_failed: 0,
      measurement_seconds: 1,
      drain_seconds: 0,
      elapsed_seconds: 1,
      completion_rps: 10,
      error_rate: 0,
      latency: { samples: 10, mean_ms: 1, p50_ms: 1, p95_ms: 2, p99_ms: 2, max_ms: 3 },
      errors: {},
    },
  },
  telemetry: {
    image_id: "image",
    baseline_memory_bytes: 1,
    baseline_anon_bytes: 1,
    peak_memory_bytes: 1_048_576,
    loaded_memory_bytes: 1,
    loaded_anon_bytes: 1,
    idle_memory_bytes: 1,
    idle_anon_bytes: 1_048_576,
    cpu_before_usec: 0,
    cpu_after_usec: 950_000,
    cpu_nr_periods_before: 0,
    cpu_nr_periods_after: 1,
    cpu_nr_throttled_before: 0,
    cpu_nr_throttled_after: 0,
    cpu_throttled_usec_before: 0,
    cpu_throttled_usec_after: 0,
    cpu_max: "100000 100000",
    cpuset_cpus_effective: "0",
    wall_seconds: 1,
    window: "load",
  },
  mock_telemetry: {
    image_id: "mock-image",
    baseline_memory_bytes: 1,
    baseline_anon_bytes: 1,
    peak_memory_bytes: 1,
    loaded_memory_bytes: 1,
    loaded_anon_bytes: 1,
    idle_memory_bytes: 1,
    idle_anon_bytes: 1,
    cpu_before_usec: 0,
    cpu_after_usec: 250_000,
    cpu_nr_periods_before: 0,
    cpu_nr_periods_after: 1,
    cpu_nr_throttled_before: 0,
    cpu_nr_throttled_after: 0,
    cpu_throttled_usec_before: 0,
    cpu_throttled_usec_after: 0,
    cpu_max: "100000 100000",
    cpuset_cpus_effective: "1",
    wall_seconds: 1,
    window: "load",
  },
  load_generator_telemetry: {
    cpu_percent: 50,
    user_seconds: 0.4,
    system_seconds: 0.1,
    max_rss_kib: 1,
    cpuset_cpus: "2-3",
  },
  upstream: { requests: 10, failures: 0, errors: {} },
  ...overrides,
});

it("classifies valid OCR fields and ignores extra dimension keys", () => {
  expect(classify(trial({
    dimensions: {
      payload_requested_bytes: 1,
      wire_body_bytes: 100,
      document_bytes: 68,
      document_sha256: "a".repeat(64),
      extra: true,
    },
  }))).toEqual({
    ok: true,
    fields: {
      variant: "python",
      payload_requested_bytes: 1,
      wire_body_bytes: 100,
      document_bytes: 68,
      document_sha256: "a".repeat(64),
    },
  });
});

it("derives proxy service demand, memory growth, and apparatus utilization", async () => {
  const row = await Effect.runPromise(decodeOcrObservation(trial(), integrity));
  expect(row).toMatchObject({
    cpu_average_percent: 95,
    cpu_ms_per_request: 95,
    peak_memory_growth_mib: (1_048_576 - 1) / 1_048_576,
    idle_anon_growth_mib: (1_048_576 - 1) / 1_048_576,
    mock_cpu_average_percent: 25,
    load_generator_cpu_percent: 50,
  });
});

it("preserves existing issue text for malformed OCR boundaries", () => {
  const { telemetry: _telemetry, ...withoutTelemetry } = trial();
  expect(classify(withoutTelemetry)).toEqual({
    ok: false,
    kind: "measurement",
    issue: "missing telemetry",
  });
  const { mock_telemetry: _mockTelemetry, ...withoutMockTelemetry } = trial();
  expect(classify(withoutMockTelemetry)).toEqual({
    ok: false,
    kind: "measurement",
    issue: "missing mock telemetry",
  });
  const { load_generator_telemetry: _loadTelemetry, ...withoutLoadTelemetry } = trial();
  expect(classify(withoutLoadTelemetry)).toEqual({
    ok: false,
    kind: "measurement",
    issue: "missing load-generator telemetry",
  });
  expect(classify(trial({
    telemetry: { ...trial().telemetry!, cpu_after_usec: 890_000 },
  }))).toEqual({
    ok: false,
    kind: "apparatus",
    issue: "proxy was not CPU-saturated: 89.0% (proxy_cpu_min_percent 90)",
  });
  expect(classify(trial({
    mock_telemetry: { ...trial().mock_telemetry!, cpu_after_usec: 800_000 },
  }))).toEqual({
    ok: false,
    kind: "apparatus",
    issue: "mock may be limiting: 80.0% CPU (mock_cpu_max_percent 80)",
  });
  expect(classify(trial({
    load_generator_telemetry: { ...trial().load_generator_telemetry!, cpu_percent: 160 },
  }))).toEqual({
    ok: false,
    kind: "apparatus",
    issue: "load generator may be limiting: 160.0% CPU (load_generator_cpu_max_percent 160)",
  });
  expect(classify(trial({ variant: "go" }))).toEqual({
    ok: false,
    kind: "measurement",
    issue: "unknown variant go",
  });
  expect(classify(trial({
    dimensions: {
      payload_requested_bytes: "1",
      wire_body_bytes: 100,
      document_bytes: 68,
      document_sha256: "a".repeat(64),
    },
  }))).toEqual({ ok: false, kind: "measurement", issue: "missing payload dimensions" });
  expect(classify(trial({
    dimensions: {
      payload_requested_bytes: Number.NaN,
      wire_body_bytes: 100,
      document_bytes: 68,
      document_sha256: "a".repeat(64),
    },
  }))).toEqual({ ok: false, kind: "measurement", issue: "missing payload dimensions" });
  expect(classify(trial({
    dimensions: {
      payload_requested_bytes: Number.POSITIVE_INFINITY,
      wire_body_bytes: 100,
      document_bytes: 68,
      document_sha256: "a".repeat(64),
    },
  }))).toEqual({ ok: false, kind: "measurement", issue: "missing payload dimensions" });
  expect(classify(trial({
    dimensions: {
      payload_requested_bytes: 1.5,
      wire_body_bytes: 100,
      document_bytes: 68,
      document_sha256: "a".repeat(64),
    },
  }))).toEqual({ ok: false, kind: "measurement", issue: "missing payload dimensions" });
  expect(classify(trial({
    dimensions: {
      payload_requested_bytes: 1,
      wire_body_bytes: 100,
      document_bytes: 68,
      document_sha256: "A".repeat(64),
    },
  }))).toEqual({ ok: false, kind: "measurement", issue: "missing payload dimensions" });
  expect(classify(trial({
    client: {
      engine: "k6",
      exit_code: 0,
      artifacts: {},
      result: {
        started: 10,
        completed: 10,
        successful: 0,
        failed: 10,
        dropped: 0,
        interrupted: 0,
        window_completed: 10,
        window_successful: 0,
        window_failed: 10,
        tail_completed: 0,
        tail_successful: 0,
        tail_failed: 0,
        warmup_requests: 0,
        warmup_failed: 0,
        measurement_seconds: 1,
        drain_seconds: 0,
        elapsed_seconds: 1,
        completion_rps: 0,
        error_rate: 1,
        latency: { samples: 10, mean_ms: 1, p50_ms: 1, p95_ms: 2, p99_ms: 2, max_ms: 3 },
        errors: {},
      },
    },
  }))).toEqual({ ok: false, kind: "measurement", issue: "no successful requests" });
});

it("judges apparatus headroom against the configured gates", () => {
  const relaxed: OcrIntegrity = {
    proxy_cpu_min_percent: 85,
    mock_cpu_max_percent: 95,
    load_generator_cpu_max_percent: 190,
  };
  const busy = trial({
    telemetry: { ...trial().telemetry!, cpu_after_usec: 890_000 },
    mock_telemetry: { ...trial().mock_telemetry!, cpu_after_usec: 900_000 },
    load_generator_telemetry: { ...trial().load_generator_telemetry!, cpu_percent: 180 },
  });
  expect(classifyOcrTrial(busy, integrity)).toMatchObject({ ok: false, kind: "apparatus" });
  expect(classifyOcrTrial(busy, relaxed)).toMatchObject({ ok: true });
});
