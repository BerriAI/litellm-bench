import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { fileURLToPath } from "node:url";

import { AnnotationDocument, validateAnnotations } from "./annotations.js";
import { decodeStrict } from "./common.js";
import { BenchmarkDefinition, validateBenchmarkDefinition } from "./metadata.js";
import { ProxyLoadObservation, validateProxyLoadObservation } from "./proxy.js";
import { BenchmarkResult, RunSpec, validateResultAgainstSpec } from "./results.js";

it.effect("all repository benchmark definitions satisfy the structural and semantic contract", () =>
  Effect.gen(function*() {
    const names = [
      "proxy-chat-completions",
      "proxy-chat-completions-streaming",
      "proxy-ocr",
      "sdk-import-footprint",
      "sdk-import-time",
      "sdk-package-size",
    ];
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const definitions = yield* Effect.forEach(
      names,
      (name) =>
        fs.readFileString(path.resolve(root, `benchmarks/${name}/benchmark.json`)).pipe(
          Effect.map((contents) => decodeStrict(BenchmarkDefinition)(JSON.parse(contents))),
        ),
      { concurrency: "unbounded" },
    );
    expect(definitions.flatMap(validateBenchmarkDefinition)).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)));

it("strict decoding reports nested excess properties", () => {
  expect(() =>
    decodeStrict(AnnotationDocument)({
      annotations: [{
        id: "change",
        benchmark_id: "sdk-import-time",
        introduced_in: "1.2.3",
        title: "Change",
        explanation: "Details",
        sources: [],
        typo: true,
      }],
    })
  ).toThrow(/typo/);
});

it("annotation semantics reject duplicate IDs and unknown catalog references", () => {
  const document = decodeStrict(AnnotationDocument)({
    annotations: [
      {
        id: "change",
        benchmark_id: "sdk-import-time",
        introduced_in: "1.2.3",
        metric_id: "missing",
        title: "Change",
        explanation: "Details",
        sources: [{ label: "Evidence", url: "https://example.com/evidence" }],
      },
      {
        id: "change",
        benchmark_id: "unknown",
        introduced_in: "bad",
        title: "Other",
        explanation: "Details",
        sources: [],
      },
    ],
  });
  const issues = validateAnnotations(document, {
    benchmarks: new Map([["sdk-import-time", new Set(["import.median"])]]),
    acceptsVersion: (version) => /^\d+\.\d+\.\d+$/.test(version),
  });
  expect(issues.map(({ path }) => path)).toEqual([
    "annotations",
    "annotations.0.metric_id",
    "annotations.1.benchmark_id",
    "annotations.1.introduced_in",
  ]);
});

it("proxy count invariants reject inconsistent observations", () => {
  const observation = decodeStrict(ProxyLoadObservation)({
    started: 4,
    completed: 3,
    successful: 3,
    failed: 0,
    dropped: 0,
    interrupted: 0,
    window_completed: 3,
    window_successful: 3,
    window_failed: 0,
    tail_completed: 0,
    tail_successful: 0,
    tail_failed: 0,
    warmup_requests: 0,
    warmup_failed: 0,
    measurement_seconds: 1,
    drain_seconds: 0,
    elapsed_seconds: 1,
    completion_rps: 3,
    error_rate: 0,
    latency: { samples: 3, mean_ms: 1, p50_ms: 1, p95_ms: 1, p99_ms: 1, max_ms: 1 },
    errors: {},
  });
  expect(validateProxyLoadObservation(observation)).toBe(false);
});

it("proxy count invariants use the fixed completion window and retain drain separately", () => {
  const observation = decodeStrict(ProxyLoadObservation)({
    started: 5,
    completed: 5,
    successful: 4,
    failed: 1,
    dropped: 2,
    interrupted: 0,
    window_completed: 4,
    window_successful: 3,
    window_failed: 1,
    tail_completed: 1,
    tail_successful: 1,
    tail_failed: 0,
    warmup_requests: 10,
    warmup_failed: 0,
    measurement_seconds: 2,
    drain_seconds: 0.2,
    elapsed_seconds: 2.2,
    completion_rps: 1.5,
    error_rate: 0.25,
    warmup_stable: true,
    warmup_cv: 0.01,
    warmup_window_rps: [10, 10.2, 9.8],
    latency: { samples: 3, mean_ms: 2, p50_ms: 2, p95_ms: 3, p99_ms: 3, max_ms: 4 },
    errors: { http: 1 },
  });
  expect(validateProxyLoadObservation(observation)).toBe(true);
});

it("successful results must match their spec and declared metric contract", () => {
  const outputMetric = { id: "import.median", unit: "ms", better: "lower" };
  const benchmark = {
    id: "sdk-import-time",
    label: "Import time",
    kind: "sdk",
    output_metrics: [outputMetric],
    protocol: {
      question: "How long?",
      scenarios: [{ id: "root", label: "Root", dimensions: {} }],
      measurements: [{
        id: "duration",
        label: "Duration",
        unit: "ms",
        role: "primary",
        better: "lower",
      }],
      analyses: [{
        id: "median",
        label: "Median",
        measurement: "duration",
        aggregation: "median",
      }],
    },
  };
  const digest = "a".repeat(64);
  const spec = decodeStrict(RunSpec)({
    case_id: digest,
    comparison_id: "b".repeat(64),
    benchmark,
    job: { id: "linux", runner: "ubuntu", config: {} },
    version: { version: "1.0.0", artifacts: { sdk: { requirement: "litellm==1.0.0" } } },
    artifact: { requirement: "litellm==1.0.0" },
  });
  const result = decodeStrict(BenchmarkResult)({
    run_id: "run-1",
    created_at: "2026-09-13T12:00:00-07:00",
    case_id: digest,
    comparison_id: "b".repeat(64),
    benchmark,
    job: { id: "linux", runner: "ubuntu", config: {} },
    version: "1.0.0",
    artifact: { requirement: "litellm==1.0.0" },
    apparatus: { harness: "typescript" },
    status: "ok",
    metrics: [{ ...outputMetric, label: "Median", value: 4 }],
    trials: [],
    analyses: [],
  });
  expect(validateResultAgainstSpec(result, spec)).toEqual([]);
  expect(validateResultAgainstSpec({ ...result, metrics: [] }, spec)[0]?.message).toMatch(
    /missing metric/,
  );
  expect(validateResultAgainstSpec({ ...result, version: "2.0.0" }, spec)[0]?.message).toMatch(
    /does not match/,
  );
});
