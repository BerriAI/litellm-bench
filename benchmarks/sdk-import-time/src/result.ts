import { type Analysis, BenchmarkResult, type Metric, type Trial } from "@litellm-bench/contracts";
import { InvalidObservation, type RunContext } from "@litellm-bench/harness";
import type { PreparedEnvironment } from "@litellm-bench/python-environment";
import { Effect, Schema } from "effect";

import type { ImportTimeObservation } from "./measurement.js";

interface ImportTimeProjection {
  readonly metrics: readonly Metric[];
  readonly trials: readonly Trial[];
  readonly analyses: readonly Analysis[];
}

export const projectImportTime = (
  raw: ImportTimeObservation,
  scenario: string,
): ImportTimeProjection => {
  const timing = raw.timing;
  const fresh = timing.fresh_process;
  const samples = fresh.samples_seconds.map((value) => value * 1_000);
  return {
    metrics: [
      {
        id: "import.median",
        label: "Median fresh import",
        value: fresh.median_seconds * 1_000,
        unit: "ms",
        better: "lower",
      },
      {
        id: "import.p95",
        label: "p95 fresh import",
        value: fresh.p95_seconds * 1_000,
        unit: "ms",
        better: "lower",
      },
      {
        id: "import.minimum",
        label: "Minimum fresh import",
        value: fresh.minimum_seconds * 1_000,
        unit: "ms",
        better: "lower",
      },
      {
        id: "import.maximum",
        label: "Maximum fresh import",
        value: fresh.maximum_seconds * 1_000,
        unit: "ms",
        better: "lower",
      },
      {
        id: "import.first",
        label: "First import in prepared environment",
        value: timing.first_ever_process_seconds * 1_000,
        unit: "ms",
        better: "lower",
      },
    ],
    trials: samples.map((sample, index) => ({
      id: `fresh-import-${index + 1}`,
      attempt: index + 1,
      scenario,
      valid: true,
      measurements: { import_duration_ms: sample },
    })),
    analyses: [{
      id: `${scenario}.fresh_import_distribution`,
      measurement: "import_duration_ms",
      aggregation: "median and nearest-rank p95",
      payload: {
        definition: "fresh_import_distribution",
        scenario,
        summary: {
          attempt_count: fresh.count,
          minimum: fresh.minimum_seconds * 1_000,
          median: fresh.median_seconds * 1_000,
          p95: fresh.p95_seconds * 1_000,
          maximum: fresh.maximum_seconds * 1_000,
        },
      },
    }],
  };
};

export const buildImportTimeResult = (
  context: RunContext,
  prepared: PreparedEnvironment,
  observation: ImportTimeObservation,
  scenario: string,
) => {
  const projected = projectImportTime(observation, scenario);
  return Schema.decodeUnknownEffect(BenchmarkResult, { onExcessProperty: "error" })({
    run_id: context.runId,
    created_at: context.createdAt,
    case_id: context.spec.case_id,
    comparison_id: context.spec.comparison_id,
    benchmark: context.spec.benchmark,
    job: context.spec.job,
    version: context.spec.version.version,
    artifact: context.spec.artifact,
    apparatus: {
      runner: "@litellm-bench/benchmark-sdk-import-time",
      host: {
        python_version: prepared.python_metadata.version,
        python_implementation: prepared.python_metadata.implementation,
      },
      python_version: prepared.python_metadata.version,
      python_implementation: prepared.python_metadata.implementation,
      uv_version: prepared.uv_version,
      pip_version: prepared.pip_version,
      timer: "python-time-perf-counter-subprocess-run",
    },
    metrics: projected.metrics,
    trials: projected.trials,
    analyses: projected.analyses,
    details: observation,
    status: "ok",
  }).pipe(Effect.mapError((error) => new InvalidObservation({ message: error.message })));
};
