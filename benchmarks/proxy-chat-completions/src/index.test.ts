import { expect, it } from "vitest";
import { projectChatCompletions } from "./projection.js";

const config = {
  rounds: 5,
  arrival_rates: [10, 20, 30],
  duration_seconds: 30,
  warmup_seconds: 15,
  steady_state: { window_seconds: 5, windows: 3, maximum_cv: 0.05 },
  slo: {
    p95_latency_ms: 100,
    maximum_error_rate: 0,
    minimum_achievement_ratio: 0.98,
    required_pass_fraction: 0.8,
  },
  retry_attempts: 2,
  vu_allocation: { slo_multiple: 4, minimum_vus: 16 },
  max_vus: 32,
  calibration_rate_multiplier: 1.5,
  calibration_headroom: { maximum_cpu_percent: 85, maximum_throttled_fraction: 0.001 },
  mock_image: `node@test@sha256:${"a".repeat(64)}`,
  resources: {
    cpus: 1,
    memory: "1g",
    workers: 1 as const,
    idle_seconds: 0,
    log_driver: "none",
    mock_cpus: 1,
    mock_memory: "1g",
    cpu_sets: { proxy: "0", mock: "1", load_generator: "2" },
  },
};

it("selects the contiguous SLO knee and reports round dispersion and confidence", () => {
  const trials = Array.from({ length: 5 }, (_, index) => index + 1).flatMap((round) => [
    ...[10, 20, 30].map((rate) => ({
      round,
      offered_rps: rate,
      completion_rps: rate === 30 ? 25 : rate,
      error_rate: 0,
      p95_latency_ms: rate === 30 ? 150 : 20,
      dropped: rate === 30 ? 1 : 0,
      warmup_stable: true,
      calibration: false,
      valid: true,
    })),
    {
      round,
      offered_rps: 45,
      completion_rps: 45,
      error_rate: 0,
      p95_latency_ms: 5,
      dropped: 0,
      warmup_stable: true,
      calibration: true,
      valid: true,
      mock_cpu_percent: 20,
      mock_throttled_fraction: 0,
      load_generator_cpu_percent: 25,
    },
  ]);
  const result = projectChatCompletions(trials, config);
  expect(result.metrics[0]?.value).toBe(20);
  expect(result.analyses[0]?.payload).toMatchObject({
    round_capacities: [20, 20, 20, 20, 20],
    median: 20,
    bootstrap_95_percent_ci: { lower: 20, upper: 20 },
  });
});

it("fails closed when calibration lacks headroom or saturation is unbracketed", () => {
  const base = Array.from({ length: 5 }, (_, index) => index + 1).flatMap((round) => [
    ...[10, 20, 30].map((rate) => ({
      round,
      offered_rps: rate,
      completion_rps: rate,
      error_rate: 0,
      p95_latency_ms: 10,
      dropped: 0,
      warmup_stable: true,
      calibration: false,
      valid: true,
    })),
    {
      round,
      offered_rps: 45,
      completion_rps: 45,
      error_rate: 0,
      p95_latency_ms: 5,
      dropped: 0,
      warmup_stable: true,
      calibration: true,
      valid: true,
      mock_cpu_percent: 20,
      mock_throttled_fraction: 0,
      load_generator_cpu_percent: 25,
    },
  ]);
  expect(() => projectChatCompletions(base, config)).toThrow(/bracket/);
  expect(() =>
    projectChatCompletions(
      base.map((trial, index) =>
        index === 3 ? { ...trial, load_generator_cpu_percent: 90 } : trial
      ),
      config,
    )
  ).toThrow(/calibration/);
});
