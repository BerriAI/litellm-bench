import { expect, it } from "@effect/vitest";
import type { ProxyLoadObservation, ProxyRawObservation } from "@litellm-bench/contracts";
import type { RunContext } from "@litellm-bench/harness";
import { canonicalOpenAiStreamingEventCount } from "@litellm-bench/provider-openai-chat-completions";
import { ProxyEnvironment, ProxyRuntimeError } from "@litellm-bench/proxy";
import { Effect } from "effect";
import { makeStreamingChatCompletionsRunner } from "../src/runner.js";

const config = {
  rounds: 5,
  arrival_rates: [10, 20, 30],
  duration_seconds: 30,
  warmup_seconds: 15,
  steady_state: { window_seconds: 5, windows: 3, maximum_cv: 0.05 },
  slo: {
    p95_ttfb_ms: 100,
    p95_stream_duration_ms: 200,
    maximum_error_rate: 0,
    minimum_achievement_ratio: 0.98,
    required_pass_fraction: 0.8,
  },
  preallocated_vus: 16,
  max_vus: 32,
  calibration_rate_multiplier: 1.5,
  calibration_headroom: { maximum_cpu_percent: 85, maximum_throttled_usec: 0 },
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
  runId: "stream-test",
  createdAt: "2026-09-13T00:00:00Z",
  artifactsDirectory: "/artifacts",
  spec: {
    case_id: "a".repeat(64),
    comparison_id: "b".repeat(64),
    benchmark: {
      id: "proxy-chat-completions-streaming",
      label: "Streaming chat capacity",
      kind: "proxy",
      output_metrics: [{ id: "stream.sustainable_rps", unit: "RPS", better: "higher" }],
      protocol: {
        question: "capacity",
        scenarios: [{
          id: "stream-arrival-sweep",
          label: "Streaming arrival sweep",
          dimensions: { arrival_rates: [10, 20, 30], stream: true },
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

const telemetry = (cpu: string) => ({
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
  cpuset_cpus_effective: cpu,
  wall_seconds: 60,
  window: "load",
});

const clientResult = (rate: number, saturated: boolean): ProxyLoadObservation => {
  const requests = rate * config.duration_seconds;
  const latency = (p95_ms: number) => ({
    samples: requests,
    mean_ms: 20,
    p50_ms: 20,
    p95_ms,
    p99_ms: p95_ms,
    max_ms: p95_ms,
  });
  return {
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
    latency: latency(saturated ? 250 : 45),
    ttfb: latency(saturated ? 150 : 20),
    stream_events: requests * canonicalOpenAiStreamingEventCount,
    event_rps: rate * canonicalOpenAiStreamingEventCount,
    errors: {},
  };
};

const raw = (): ProxyRawObservation => ({
  metadata: { docker: "test" },
  trials: Array.from({ length: config.rounds }, (_, index) => index + 1).flatMap((round) =>
    [...config.arrival_rates, 45].map((rate) => {
      const calibration = rate === 45;
      const requests = rate * config.duration_seconds;
      return {
        id: calibration ? `calibration_rate45_r${round}` : `stream_rate${rate}_r${round}`,
        scenario: "stream-arrival-sweep",
        variant: calibration ? "bypass-calibration" : `rate-${rate}`,
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
        dimensions: { offered_rps: rate, stream: true, calibration },
        client: {
          engine: "k6",
          exit_code: 0,
          artifacts: {},
          result: clientResult(rate, !calibration && rate === 30),
        },
        ...(calibration ? {} : { telemetry: telemetry("0") }),
        mock_telemetry: telemetry("1"),
        load_generator_telemetry: {
          cpu_percent: 20,
          user_seconds: 1,
          system_seconds: 1,
          max_rss_kib: 100,
          cpuset_cpus: "2",
        },
        upstream: {
          requests: requests + 30,
          failures: 0,
          errors: {},
          streams: {
            started: requests + 30,
            completed: requests + 30,
            cancelled: 0,
            failed: 0,
          },
        },
      };
    })
  ),
});

it.effect("runs the streaming sweep and reports bracketed capacity", () =>
  Effect.gen(function*() {
    const experiments: any[] = [];
    const runner = yield* makeStreamingChatCompletionsRunner.pipe(
      Effect.provideService(ProxyEnvironment, {
        run: (experiment) => Effect.sync(() => (experiments.push(experiment), raw())),
      }),
    );
    const result = yield* runner.run(context);
    expect(result.metrics[0]?.value).toBe(20);
    expect(result.trials).toHaveLength(20);
    expect(experiments[0].trials[0].workload.response.sse.event_count).toBe(
      canonicalOpenAiStreamingEventCount,
    );
  }));

it.effect("fails closed when streaming timing is absent", () =>
  Effect.gen(function*() {
    const observation = raw();
    const first = observation.trials[0]!;
    const broken = {
      ...observation,
      trials: [{
        ...first,
        client: { ...first.client!, result: { ...first.client!.result!, ttfb: undefined } },
      }, ...observation.trials.slice(1)],
    } as ProxyRawObservation;
    const runner = yield* makeStreamingChatCompletionsRunner.pipe(
      Effect.provideService(ProxyEnvironment, { run: () => Effect.succeed(broken) }),
    );
    expect(yield* Effect.flip(runner.run(context))).toMatchObject({
      _tag: "InvalidObservation",
      message: expect.stringContaining("missing streaming TTFB"),
    });
  }));

it.effect("classifies proxy runtime failures as runner execution failures", () =>
  Effect.gen(function*() {
    const runner = yield* makeStreamingChatCompletionsRunner.pipe(
      Effect.provideService(ProxyEnvironment, {
        run: () =>
          Effect.fail(
            new ProxyRuntimeError({ operation: "verify Docker", message: "unavailable" }),
          ),
      }),
    );

    expect(yield* Effect.flip(runner.run(context))).toMatchObject({
      _tag: "RunnerExecutionError",
      message: "verify Docker: unavailable",
    });
  }));
