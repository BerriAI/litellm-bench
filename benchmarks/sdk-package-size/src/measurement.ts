import { type SdkBenchmarkSpec, SdkRawObservation } from "@litellm-bench/contracts";
import { InvalidObservation } from "@litellm-bench/harness";
import type { PreparedEnvironment } from "@litellm-bench/python-environment";
import { Effect, Schema } from "effect";
import type { HostRuntime } from "./config.js";
import { PackageSizeProbe } from "./probe.js";

export const observePackageSize = Effect.fn("PackageSize.observe")(
  function*(
    prepared: PreparedEnvironment,
    spec: SdkBenchmarkSpec,
    expectedVersion: string,
    host: HostRuntime,
  ) {
    const probe = yield* PackageSizeProbe;
    const installed = yield* probe.installedSize(prepared.installed_files);
    return yield* Schema.decodeUnknownEffect(SdkRawObservation, { onExcessProperty: "error" })({
      runtime: {
        resolved_package_version: prepared.package_version,
        ...prepared.python_metadata,
        platform: host.platform,
        architecture: host.architecture,
      },
      diagnostics: {},
      resolution: {
        artifact_count: prepared.artifacts.length,
        download_bytes: prepared.artifacts.reduce((total, artifact) => total + artifact.bytes, 0),
        ...(prepared.package_artifact_bytes === undefined
          ? {}
          : { package_artifact_bytes: prepared.package_artifact_bytes }),
        artifacts: prepared.artifacts,
        policy: "same-campaign-wheel-closure-v1",
        inputs: {
          python: spec.runtime.python,
          requirement: spec.subject.requirement,
          distribution: spec.subject.distribution,
          expected_version: expectedVersion,
          resolver: spec.resolver,
        },
      },
      size: {
        installed_before_first_run: {
          logical_bytes: installed.logical_bytes,
          ...(installed.allocated_bytes === null
            ? {}
            : { allocated_bytes: installed.allocated_bytes }),
        },
      },
    }).pipe(Effect.mapError((error) => new InvalidObservation({ message: error.message })));
  },
);
