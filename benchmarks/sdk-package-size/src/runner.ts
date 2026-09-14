import {
  type BenchmarkRunner,
  type RunContext,
  RunnerExecutionError,
} from "@litellm-bench/harness";
import { PythonEnvironment } from "@litellm-bench/python-environment";
import { Effect } from "effect";
import { currentHost, decodePackageSizeSpec } from "./config.js";
import { observePackageSize } from "./measurement.js";
import { PackageSizeProbe, PackageSizeProbeLive } from "./probe.js";
import { buildPackageSizeResult } from "./result.js";

export const makePackageSizeRunner: Effect.Effect<
  BenchmarkRunner,
  never,
  PythonEnvironment | PackageSizeProbe
> = Effect.gen(function*() {
  const environments = yield* PythonEnvironment;
  const probe = yield* PackageSizeProbe;
  return {
    id: "sdk-package-size",
    run: Effect.fn("PackageSize.run")(function*(context: RunContext) {
      const spec = yield* decodePackageSizeSpec(context);
      const prepared = yield* environments.prepare({
        python: spec.runtime.python,
        requirement: spec.subject.requirement,
        distribution: spec.subject.distribution,
        expected_version: context.spec.version.version,
        resolver: spec.resolver,
        artifacts_dir: context.artifactsDirectory,
        environment: spec.environment,
        timeout_seconds: spec.measurements.timeout_seconds,
      }).pipe(
        Effect.mapError((error) => new RunnerExecutionError({ message: error.message })),
      );
      if (prepared.package_version !== context.spec.version.version) {
        return yield* new RunnerExecutionError({
          message:
            `Requested ${spec.subject.distribution} ${context.spec.version.version}, but installed ${prepared.package_version}`,
        });
      }
      const observation = yield* observePackageSize(
        prepared,
        spec,
        context.spec.version.version,
        currentHost,
      ).pipe(Effect.provideService(PackageSizeProbe, probe));
      return yield* buildPackageSizeResult(context, prepared, observation);
    }, Effect.scoped),
  };
});

export const runner = makePackageSizeRunner.pipe(Effect.provide(PackageSizeProbeLive));
