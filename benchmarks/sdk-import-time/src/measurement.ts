import { summarize } from "@litellm-bench/analysis";
import { SdkBenchmarkSpec, SdkRawObservation } from "@litellm-bench/contracts";
import { InvalidObservation } from "@litellm-bench/harness";
import { type FileSize, type PreparedEnvironment } from "@litellm-bench/python-environment";
import { Effect, Schema } from "effect";

import type { HostRuntime } from "./config.js";
import { ImportTimeProbe } from "./probe.js";

export type ImportTimeObservation = SdkRawObservation & {
  readonly timing: NonNullable<SdkRawObservation["timing"]>;
};

const directoryMeasurement = (size: FileSize) => ({
  logical_bytes: size.logical_bytes,
  ...(size.allocated_bytes === null ? {} : { allocated_bytes: size.allocated_bytes }),
});

export const measureImportTime = Effect.fn("ImportTime.measure")(function*(
  prepared: PreparedEnvironment,
  spec: SdkBenchmarkSpec,
  artifactsDirectory: string,
  host: HostRuntime,
) {
  const probe = yield* ImportTimeProbe;
  const before = yield* probe.installedSize(prepared.site_packages);
  const first = yield* probe.measureBatch(
    prepared,
    spec,
    "first",
    1,
  );
  const after = yield* probe.installedSize(prepared.site_packages);
  const warmups = spec.measurements.warmups === 0
    ? []
    : yield* probe.measureBatch(
      prepared,
      spec,
      "warmups",
      spec.measurements.warmups,
    );
  const samples = yield* probe.measureBatch(
    prepared,
    spec,
    "samples",
    spec.measurements.samples,
  );
  const summary = summarize(samples);
  if (summary._tag === "NoFiniteValues") {
    return yield* Effect.fail(
      new InvalidObservation({ message: "Timing probe returned no finite samples" }),
    );
  }
  const importtime = spec.measurements.importtime
    ? yield* probe.collectImporttime(prepared, spec, artifactsDirectory)
    : undefined;
  const raw = yield* Schema.decodeUnknownEffect(SdkRawObservation, { onExcessProperty: "error" })(
    {
      runtime: {
        requested_python: spec.runtime.python,
        resolved_package_version: prepared.package_version,
        ...prepared.python_metadata,
        platform: host.platform,
        architecture: host.architecture,
      },
      timing: {
        first_ever_process_seconds: first[0],
        warmup_samples_seconds: warmups,
        fresh_process: {
          count: summary.value.count,
          samples_seconds: samples,
          minimum_seconds: summary.value.minimum,
          median_seconds: summary.value.median,
          p95_seconds: summary.value.p95,
          maximum_seconds: summary.value.maximum,
        },
      },
      diagnostics: importtime === undefined ? {} : { importtime },
      resolution: {
        artifact_count: prepared.artifacts.length,
        download_bytes: prepared.artifacts.reduce((total, artifact) => total + artifact.bytes, 0),
        artifacts: prepared.artifacts,
      },
      size: {
        installed_before_first_run: directoryMeasurement(before),
        installed_after_first_run: directoryMeasurement(after),
        first_run_logical_delta_bytes: after.logical_bytes - before.logical_bytes,
        ...(before.allocated_bytes === null || after.allocated_bytes === null
          ? {}
          : { first_run_allocated_delta_bytes: after.allocated_bytes - before.allocated_bytes }),
      },
    },
  ).pipe(Effect.mapError((error) => new InvalidObservation({ message: error.message })));
  if (raw.timing === undefined) {
    return yield* Effect.fail(
      new InvalidObservation({ message: "Timing observation is missing" }),
    );
  }
  return { ...raw, timing: raw.timing };
});
