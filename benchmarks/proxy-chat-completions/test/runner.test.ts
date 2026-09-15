import { expect, it } from "@effect/vitest";
import type { ProxyRawObservation } from "@litellm-bench/contracts";
import type { RunContext } from "@litellm-bench/harness";
import { ProxyEnvironment, ProxyRuntimeError } from "@litellm-bench/proxy";
import { Effect, Path } from "effect";
import { decodeChatRun } from "../src/config.js";
import { makeChatCompletionsRunner as makeRunner } from "../src/runner.js";

const makeChatCompletionsRunner = makeRunner.pipe(Effect.provide(Path.layer));

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
  mock_image: `node:24@sha256:${"a".repeat(64)}`,
  resources: {
    cpus: 1,
    memory: "2g",
    workers: 1,
    idle_seconds: 0,
    log_driver: "none",
    mock_cpus: 1,
    mock_memory: "1g",
    cpu_sets: { proxy: "0", mock: "1", load_generator: "2" },
  },
};

const context: RunContext = {
  runId: "chat-test",
  createdAt: "2026-09-13T00:00:00Z",
  artifactsDirectory: "/artifacts",
  spec: {
    case_id: "a".repeat(64),
    comparison_id: "b".repeat(64),
    benchmark: {
      id: "proxy-chat-completions",
      label: "LiteLLM proxy chat-completions sustainable capacity",
      kind: "proxy",
      output_metrics: [{ id: "nonstream.sustainable_rps", unit: "RPS", better: "higher" }],
      protocol: {
        question: "capacity",
        scenarios: [{
          id: "nonstream-arrival-sweep",
          label: "Arrival sweep",
          dimensions: { arrival_rates: [10, 20, 30], stream: false },
        }],
        measurements: [],
        analyses: [],
      },
    },
    job: { id: "test", runner: "test", config },
    version: { version: "1", artifacts: {} },
    artifact: { image: "proxy:test" },
  },
};

const telemetry = {
  image_id: "sha256:image",
  baseline_memory_bytes: 1,
  baseline_anon_bytes: 1,
  peak_memory_bytes: 2,
  loaded_memory_bytes: 2,
  loaded_anon_bytes: 2,
  idle_memory_bytes: 1,
  idle_anon_bytes: 1,
  cpu_before_usec: 0,
  cpu_after_usec: 12_000_000,
  cpu_nr_periods_before: 0,
  cpu_nr_periods_after: 1,
  cpu_nr_throttled_before: 0,
  cpu_nr_throttled_after: 0,
  cpu_throttled_usec_before: 0,
  cpu_throttled_usec_after: 0,
  cpu_max: "100000 100000",
  cpuset_cpus_effective: "1",
  wall_seconds: 60,
  window: "load",
};
const proxyTelemetry = { ...telemetry, cpuset_cpus_effective: "0" };

const raw = (invalid = false): ProxyRawObservation => ({
  metadata: { docker: "test" },
  trials: Array.from({ length: config.rounds }, (_, index) => index + 1).flatMap((round) => [
    ...config.arrival_rates.map((rate) => {
      const requests = rate * config.duration_seconds;
      const saturated = rate === 30;
      return {
        id: `nonstream_rate${rate}_r${round}`,
        scenario: "nonstream-arrival-sweep",
        variant: `rate-${rate}`,
        round,
        load: {
          mode: "fixed" as const,
          rate,
          preallocated_vus: 16,
          max_vus: 32,
          duration_seconds: 30,
          warmup_seconds: 15,
          steady_state: config.steady_state,
        },
        dimensions: { offered_rps: rate, calibration: false },
        client: {
          engine: "k6",
          exit_code: 0,
          artifacts: {},
          result: {
            started: requests,
            completed: requests,
            successful: requests,
            failed: 0,
            dropped: saturated ? 1 : 0,
            interrupted: 0,
            window_completed: requests,
            window_successful: requests,
            window_failed: 0,
            tail_completed: 0,
            tail_successful: 0,
            tail_failed: 0,
            warmup_requests: 30,
            warmup_failed: 0,
            measurement_seconds: 30,
            drain_seconds: 0,
            elapsed_seconds: 30,
            completion_rps: rate,
            error_rate: 0,
            warmup_stable: true,
            warmup_cv: 0,
            warmup_window_rps: [rate, rate, rate],
            latency: {
              samples: requests,
              mean_ms: 10,
              p50_ms: 10,
              p95_ms: saturated ? 150 : 20,
              p99_ms: 25,
              max_ms: 30,
            },
            errors: {},
          },
        },
        telemetry: proxyTelemetry,
        mock_telemetry: telemetry,
        load_generator_telemetry: {
          cpu_percent: 20,
          user_seconds: 1,
          system_seconds: 1,
          max_rss_kib: 100,
          cpuset_cpus: "2",
        },
        upstream: {
          requests: requests + 30 + (invalid && round === 1 && rate === 10 ? 1 : 0),
          failures: 0,
          errors: {},
        },
      };
    }),
    {
      id: `calibration_rate45_r${round}`,
      scenario: "nonstream-arrival-sweep",
      variant: "bypass-calibration",
      round,
      load: {
        mode: "fixed" as const,
        rate: 45,
        preallocated_vus: 16,
        max_vus: 32,
        duration_seconds: 30,
        warmup_seconds: 15,
        steady_state: config.steady_state,
      },
      dimensions: { offered_rps: 45, calibration: true },
      client: {
        engine: "k6",
        exit_code: 0,
        artifacts: {},
        result: {
          started: 1350,
          completed: 1350,
          successful: 1350,
          failed: 0,
          dropped: 0,
          interrupted: 0,
          window_completed: 1350,
          window_successful: 1350,
          window_failed: 0,
          tail_completed: 0,
          tail_successful: 0,
          tail_failed: 0,
          warmup_requests: 30,
          warmup_failed: 0,
          measurement_seconds: 30,
          drain_seconds: 0,
          elapsed_seconds: 30,
          completion_rps: 45,
          error_rate: 0,
          warmup_stable: true,
          warmup_cv: 0,
          warmup_window_rps: [45, 45, 45],
          latency: { samples: 1350, mean_ms: 2, p50_ms: 2, p95_ms: 3, p99_ms: 4, max_ms: 5 },
          errors: {},
        },
      },
      mock_telemetry: telemetry,
      load_generator_telemetry: {
        cpu_percent: 20,
        user_seconds: 1,
        system_seconds: 1,
        max_rss_kib: 100,
        cpuset_cpus: "2",
      },
      upstream: { requests: 1380, failures: 0, errors: {} },
    },
  ]),
});

it.effect("strictly validates sweep, image digest, and disjoint CPU sets", () =>
  Effect.gen(function*() {
    for (
      const badConfig of [
        { ...config, arrival_rates: [10, 10, 30] },
        { ...config, mock_image: "node:latest" },
        {
          ...config,
          resources: {
            ...config.resources,
            cpu_sets: { proxy: "0", mock: "0", load_generator: "2" },
          },
        },
      ]
    ) {
      const candidate = {
        ...context,
        spec: { ...context.spec, job: { ...context.spec.job, config: badConfig } },
      };
      expect((yield* Effect.flip(decodeChatRun(candidate)))._tag).toBe("InvalidRunnerConfig");
    }
  }));

it.effect("constructs the sweep and reports its bracketed sustainable capacity", () =>
  Effect.gen(function*() {
    const experiments: any[] = [];
    const runner = yield* makeChatCompletionsRunner.pipe(Effect.provideService(ProxyEnvironment, {
      run: (experiment) =>
        Effect.sync(() => {
          experiments.push(experiment);
          return raw();
        }),
    }));
    const result = yield* runner.run(context);
    expect(experiments[0].trials).toHaveLength(20);
    expect(experiments[0].trials.filter((trial: any) => trial.bypassProxy)).toHaveLength(5);
    expect(result.metrics[0]?.value).toBe(20);
    expect(result.trials).toHaveLength(20);
  }));

it.effect("rejects request-accounting mismatches and preserves runtime operation context", () =>
  Effect.gen(function*() {
    const invalidRunner = yield* makeChatCompletionsRunner.pipe(
      Effect.provideService(ProxyEnvironment, { run: () => Effect.succeed(raw(true)) }),
    );
    expect(yield* Effect.flip(invalidRunner.run(context))).toMatchObject({
      _tag: "InvalidObservation",
      message: expect.stringContaining("request counts differ"),
    });
    const failedRunner = yield* makeChatCompletionsRunner.pipe(
      Effect.provideService(ProxyEnvironment, {
        run: () =>
          Effect.fail(
            new ProxyRuntimeError({ operation: "verify Docker", message: "unavailable" }),
          ),
      }),
    );
    expect(yield* Effect.flip(failedRunner.run(context))).toMatchObject({
      _tag: "RunnerExecutionError",
      message: "verify Docker: unavailable",
    });
  }));
