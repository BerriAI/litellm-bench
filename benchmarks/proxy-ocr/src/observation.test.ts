import type { ProxyRawObservation } from "@litellm-bench/contracts";
import { expect, it } from "vitest";
import { classifyOcrTrial } from "./observation.js";

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
    cpu_after_usec: 500_000,
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
  upstream: { requests: 10, failures: 0, errors: {} },
  ...overrides,
});

it("classifies valid OCR fields and ignores extra dimension keys", () => {
  expect(classifyOcrTrial(trial({
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

it("preserves existing issue text for malformed OCR boundaries", () => {
  const { telemetry: _telemetry, ...withoutTelemetry } = trial();
  expect(classifyOcrTrial(withoutTelemetry)).toEqual({
    ok: false,
    issue: "missing telemetry",
  });
  expect(classifyOcrTrial(trial({ variant: "go" }))).toEqual({
    ok: false,
    issue: "unknown variant go",
  });
  expect(classifyOcrTrial(trial({
    dimensions: {
      payload_requested_bytes: "1",
      wire_body_bytes: 100,
      document_bytes: 68,
      document_sha256: "a".repeat(64),
    },
  }))).toEqual({ ok: false, issue: "missing payload dimensions" });
  expect(classifyOcrTrial(trial({
    dimensions: {
      payload_requested_bytes: Number.NaN,
      wire_body_bytes: 100,
      document_bytes: 68,
      document_sha256: "a".repeat(64),
    },
  }))).toEqual({ ok: false, issue: "missing payload dimensions" });
  expect(classifyOcrTrial(trial({
    dimensions: {
      payload_requested_bytes: Number.POSITIVE_INFINITY,
      wire_body_bytes: 100,
      document_bytes: 68,
      document_sha256: "a".repeat(64),
    },
  }))).toEqual({ ok: false, issue: "missing payload dimensions" });
  expect(classifyOcrTrial(trial({
    dimensions: {
      payload_requested_bytes: 1.5,
      wire_body_bytes: 100,
      document_bytes: 68,
      document_sha256: "a".repeat(64),
    },
  }))).toEqual({ ok: false, issue: "missing payload dimensions" });
  expect(classifyOcrTrial(trial({
    dimensions: {
      payload_requested_bytes: 1,
      wire_body_bytes: 100,
      document_bytes: 68,
      document_sha256: "A".repeat(64),
    },
  }))).toEqual({ ok: false, issue: "missing payload dimensions" });
  expect(classifyOcrTrial(trial({
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
  }))).toEqual({ ok: false, issue: "no successful requests" });
});
