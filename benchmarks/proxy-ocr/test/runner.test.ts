import { expect, it } from "@effect/vitest";
import type { ProxyRawObservation } from "@litellm-bench/contracts";
import { InvalidObservation, type RunContext } from "@litellm-bench/harness";
import { ProxyEnvironment, ProxyRuntimeError } from "@litellm-bench/proxy";
import { Effect, Path } from "effect";
import { OcrArtifacts } from "../src/artifacts.js";
import { decodeOcrRun } from "../src/config.js";
import { makeOcrRunner } from "../src/runner.js";

const makeTestRunner = makeOcrRunner.pipe(Effect.provide(Path.layer));

const config = {
  cpus: 1,
  proxy_cpu_set: "0",
  mock_cpu_set: "0",
  load_generator_cpu_set: "0",
  mock_cpus: 1,
  memory: "2g",
  mock_memory: "512m",
  workers: 1,
  mock_image: `node:test@sha256:${"a".repeat(64)}`,
  rounds: 1,
  retry_attempts: 3,
  order_seed: "test-seed",
  warmup_seconds: 0,
  duration_seconds: 1,
  idle_seconds: 0,
  log_driver: "none",
};
const scenario = {
  id: "core",
  label: "Core",
  dimensions: { payload_bytes: 1, concurrency: 2, load_model: "closed-loop" },
};
const context: RunContext = {
  runId: "ocr-test",
  createdAt: "2026-09-13T00:00:00Z",
  artifactsDirectory: "/artifacts",
  spec: {
    case_id: "a".repeat(64),
    comparison_id: "b".repeat(64),
    benchmark: {
      id: "proxy-ocr",
      label: "LiteLLM proxy OCR throughput: Python vs Rust",
      kind: "proxy",
      output_metrics: [],
      protocol: { question: "ocr", scenarios: [scenario], measurements: [], analyses: [] },
    },
    job: { id: "test", runner: "test", config },
    version: { version: "1", artifacts: {} },
    artifact: { image: "proxy:test" },
  },
};
const raw = (missingTelemetry = false): ProxyRawObservation => ({
  metadata: { docker: "test" },
  trials: (["rust", "python"] as const).map((variant) => ({
    id: `core_${variant}_r1`,
    scenario: "core",
    variant,
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
        completion_rps: variant === "python" ? 10 : 20,
        error_rate: 0,
        latency: { samples: 10, mean_ms: 1, p50_ms: 1, p95_ms: 2, p99_ms: 2, max_ms: 3 },
        errors: {},
      },
    },
    ...(missingTelemetry && variant === "rust" ? {} : {
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
    }),
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
  })),
});

it.effect("strictly validates config, scenarios, and subject", () =>
  Effect.gen(function*() {
    for (
      const candidate of [
        {
          ...context,
          spec: {
            ...context.spec,
            job: { ...context.spec.job, config: { ...config, typo: true } },
          },
        },
        { ...context, spec: { ...context.spec, artifact: {} } },
        {
          ...context,
          spec: {
            ...context.spec,
            benchmark: {
              ...context.spec.benchmark,
              protocol: { ...context.spec.benchmark.protocol, scenarios: [scenario, scenario] },
            },
          },
        },
      ]
    ) expect((yield* Effect.flip(decodeOcrRun(candidate)))._tag).toBe("InvalidRunnerConfig");
  }));

it.effect("constructs paired trials, writes primary rows, and projects the ratio", () =>
  Effect.gen(function*() {
    const experiments: unknown[] = [];
    const written: unknown[] = [];
    const runner = yield* makeTestRunner.pipe(
      Effect.provideService(ProxyEnvironment, {
        run: (experiment) =>
          Effect.sync(() => {
            experiments.push(experiment);
            return raw();
          }),
      }),
      Effect.provideService(OcrArtifacts, {
        writeRows: (_directory, rows) =>
          Effect.sync(() => {
            written.push(...rows);
          }),
      }),
    );
    const result = yield* runner.run(context);
    expect(experiments).toHaveLength(1);
    expect(written).toHaveLength(2);
    expect(result.metrics.find(({ id }) => id === "core.paired_ratio")?.value).toBe(2);
    expect(result.trials).toHaveLength(2);
  }));

it.effect("rejects missing telemetry before writing publishable rows", () =>
  Effect.gen(function*() {
    let writes = 0;
    const runner = yield* makeTestRunner.pipe(
      Effect.provideService(ProxyEnvironment, { run: () => Effect.succeed(raw(true)) }),
      Effect.provideService(OcrArtifacts, {
        writeRows: () =>
          Effect.sync(() => {
            writes += 1;
          }),
      }),
    );
    expect(yield* Effect.flip(runner.run(context))).toMatchObject({
      _tag: "InvalidObservation",
      message: expect.stringContaining("missing telemetry"),
    });
    expect(writes).toBe(0);
  }));

it.effect("classifies proxy runtime failures as runner execution failures", () =>
  Effect.gen(function*() {
    const runner = yield* makeTestRunner.pipe(
      Effect.provideService(ProxyEnvironment, {
        run: () =>
          Effect.fail(
            new ProxyRuntimeError({ operation: "verify Docker", message: "unavailable" }),
          ),
      }),
      Effect.provideService(OcrArtifacts, { writeRows: () => Effect.void }),
    );

    expect(yield* Effect.flip(runner.run(context))).toMatchObject({
      _tag: "RunnerExecutionError",
      message: "verify Docker: unavailable",
    });
  }));

it.effect("reruns the entire paired round after a failed trial", () =>
  Effect.gen(function*() {
    const experiments: Array<{ readonly trials: readonly { readonly id: string }[] }> = [];
    const runner = yield* makeTestRunner.pipe(
      Effect.provideService(ProxyEnvironment, {
        run: (experiment) =>
          Effect.sync(() => {
            experiments.push(experiment);
            return experiments.length === 1 ? raw(true) : raw();
          }),
      }),
      Effect.provideService(OcrArtifacts, { writeRows: () => Effect.void }),
    );
    const result = yield* runner.run(context);
    expect(result.status).toBe("ok");
    expect(experiments).toHaveLength(2);
    expect(experiments[1]?.trials).toHaveLength(2);
    expect(experiments[1]?.trials.every(({ id }) => id.endsWith("_retry2"))).toBe(true);
  }));

it.effect("keeps artifact persistence failures typed", () =>
  Effect.gen(function*() {
    const runner = yield* makeTestRunner.pipe(
      Effect.provideService(ProxyEnvironment, { run: () => Effect.succeed(raw()) }),
      Effect.provideService(OcrArtifacts, {
        writeRows: () => Effect.fail(new InvalidObservation({ message: "disk full" })),
      }),
    );
    expect(yield* Effect.flip(runner.run(context))).toMatchObject({
      _tag: "InvalidObservation",
      message: "disk full",
    });
  }));
