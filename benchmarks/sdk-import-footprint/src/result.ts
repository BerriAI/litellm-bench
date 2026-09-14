import { BenchmarkResult, type Metric, type SdkRawObservation } from "@litellm-bench/contracts";
import { InvalidObservation, type RunContext } from "@litellm-bench/harness";
import type { PreparedEnvironment } from "@litellm-bench/python-environment";
import { Effect, Schema } from "effect";

export const projectImportFootprint = (raw: SdkRawObservation): readonly Metric[] => {
  const rss = raw.diagnostics.peak_rss_bytes;
  const modules = raw.diagnostics.new_module_count;
  const growth = raw.size.first_run_logical_delta_bytes;
  if (rss === undefined || modules === undefined || growth === undefined) {
    throw new Error("import-footprint observation is missing diagnostics or first-run growth");
  }
  return [
    {
      id: "import.peak_rss",
      label: "Process-lifetime peak RSS during import",
      value: rss / 1_048_576,
      unit: "MiB",
      better: "lower",
    },
    {
      id: "import.loaded_modules",
      label: "Modules loaded by import",
      value: modules,
      unit: "modules",
      better: "lower",
    },
    {
      id: "import.disk_growth",
      label: "First-import site-packages growth",
      value: growth / 1_048_576,
      unit: "MiB",
      better: "lower",
    },
  ];
};
export const buildImportFootprintResult = Effect.fn("ImportFootprint.buildResult")(
  function*(context: RunContext, prepared: PreparedEnvironment, observation: SdkRawObservation) {
    const metrics = yield* Effect.try({
      try: () => projectImportFootprint(observation),
      catch: (error) =>
        new InvalidObservation({ message: error instanceof Error ? error.message : String(error) }),
    });
    return yield* Schema.decodeUnknownEffect(BenchmarkResult, { onExcessProperty: "error" })({
      run_id: context.runId,
      created_at: context.createdAt,
      case_id: context.spec.case_id,
      comparison_id: context.spec.comparison_id,
      benchmark: context.spec.benchmark,
      job: context.spec.job,
      version: context.spec.version.version,
      artifact: context.spec.artifact,
      apparatus: {
        runner: "@litellm-bench/benchmark-sdk-import-footprint",
        host: {
          python_version: prepared.python_metadata.version,
          python_implementation: prepared.python_metadata.implementation,
        },
        uv_version: prepared.uv_version,
        pip_version: prepared.pip_version,
      },
      metrics,
      trials: [],
      analyses: [],
      details: observation,
      status: "ok",
    }).pipe(Effect.mapError((error) => new InvalidObservation({ message: error.message })));
  },
);
