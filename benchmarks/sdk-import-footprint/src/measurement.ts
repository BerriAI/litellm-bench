import { type SdkBenchmarkSpec, SdkRawObservation } from "@litellm-bench/contracts";
import { InvalidObservation } from "@litellm-bench/harness";
import type { FileSize, PreparedEnvironment } from "@litellm-bench/python-environment";
import { Effect, Schema } from "effect";
import type { HostRuntime } from "./config.js";
import { ImportFootprintProbe } from "./probe.js";

const directory = (size: FileSize) => ({
  logical_bytes: size.logical_bytes,
  ...(size.allocated_bytes === null ? {} : { allocated_bytes: size.allocated_bytes }),
});
export const measureImportFootprint = Effect.fn("ImportFootprint.measure")(
  function*(
    diskPrepared: PreparedEnvironment,
    diagnosticPrepared: PreparedEnvironment,
    spec: SdkBenchmarkSpec,
    host: HostRuntime,
  ) {
    const probe = yield* ImportFootprintProbe;
    const before = yield* probe.installedSize(diskPrepared.site_packages);
    yield* probe.runFirstImport(diskPrepared, spec);
    const after = yield* probe.installedSize(diskPrepared.site_packages);
    const peakRss = yield* probe.collectPeakRss(diagnosticPrepared, spec);
    const diagnostics = {
      ...(yield* probe.collectDiagnostics(diagnosticPrepared, spec)),
      peak_rss_bytes: peakRss,
    };
    const logicalDelta = after.logical_bytes - before.logical_bytes;
    if (logicalDelta < 0) {
      return yield* new InvalidObservation({
        message: `First import reduced installed size by ${-logicalDelta} bytes`,
      });
    }
    return yield* Schema.decodeUnknownEffect(SdkRawObservation, { onExcessProperty: "error" })({
      runtime: {
        requested_python: spec.runtime.python,
        resolved_package_version: diskPrepared.package_version,
        ...diskPrepared.python_metadata,
        platform: host.platform,
        architecture: host.architecture,
      },
      diagnostics,
      resolution: {
        artifact_count: diskPrepared.artifacts.length,
        download_bytes: diskPrepared.artifacts.reduce(
          (total, artifact) => total + artifact.bytes,
          0,
        ),
        ...(diskPrepared.package_artifact_bytes === undefined
          ? {}
          : { package_artifact_bytes: diskPrepared.package_artifact_bytes }),
        artifacts: diskPrepared.artifacts,
      },
      size: {
        installed_before_first_run: directory(before),
        installed_after_first_run: directory(after),
        first_run_logical_delta_bytes: logicalDelta,
        ...(before.allocated_bytes === null || after.allocated_bytes === null
          ? {}
          : { first_run_allocated_delta_bytes: after.allocated_bytes - before.allocated_bytes }),
      },
    }).pipe(Effect.mapError((error) => new InvalidObservation({ message: error.message })));
  },
);
