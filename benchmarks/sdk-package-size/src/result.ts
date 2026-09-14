import { BenchmarkResult, type Metric, type SdkRawObservation } from "@litellm-bench/contracts";
import { InvalidObservation, type RunContext } from "@litellm-bench/harness";
import type { PreparedEnvironment } from "@litellm-bench/python-environment";
import { Effect, Schema } from "effect";

const mib = (bytes: number): number => bytes / 1_048_576;
export const projectPackageSize = (raw: SdkRawObservation): readonly Metric[] => {
  const wheel = raw.resolution.package_artifact_bytes;
  if (wheel === undefined) {
    throw new Error("package-size observation is missing the subject artifact size");
  }
  return [
    {
      id: "package.wheel",
      label: "LiteLLM wheel",
      value: mib(wheel),
      unit: "MiB",
      better: "lower",
    },
    {
      id: "package.download",
      label: "Dependency download closure",
      value: mib(raw.resolution.download_bytes),
      unit: "MiB",
      better: "lower",
    },
    {
      id: "package.installed",
      label: "Installed RECORD footprint before import",
      value: mib(raw.size.installed_before_first_run.logical_bytes),
      unit: "MiB",
      better: "lower",
    },
    {
      id: "package.artifacts",
      label: "Downloaded artifact count",
      value: raw.resolution.artifact_count,
      unit: "artifacts",
      better: "lower",
    },
  ];
};

export const buildPackageSizeResult = Effect.fn("PackageSize.buildResult")(
  function*(context: RunContext, prepared: PreparedEnvironment, observation: SdkRawObservation) {
    const metrics = yield* Effect.try({
      try: () => projectPackageSize(observation),
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
        runner: "@litellm-bench/benchmark-sdk-package-size",
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
