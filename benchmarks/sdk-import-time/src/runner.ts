import {
  type BenchmarkRunner,
  type RunContext,
  RunnerExecutionError,
} from "@litellm-bench/harness";
import { PythonEnvironment } from "@litellm-bench/python-environment";
import { Effect } from "effect";

import { currentHost, decodeImportTimeSpec } from "./config.js";
import { measureImportTime } from "./measurement.js";
import { ImportTimeProbe, ImportTimeProbeLive } from "./probe.js";
import { buildImportTimeResult } from "./result.js";

export const makeImportTimeRunner: Effect.Effect<
  BenchmarkRunner,
  never,
  PythonEnvironment | ImportTimeProbe
> = Effect.gen(function*() {
  const environments = yield* PythonEnvironment;
  const probe = yield* ImportTimeProbe;

  return {
    id: "sdk-import-time",
    run: Effect.fn("ImportTime.run")(function*(context: RunContext) {
      const spec = yield* decodeImportTimeSpec(context);

      const prepared = yield* environments.prepare({
        python: spec.runtime.python,
        requirement: spec.subject.requirement,
        distribution: spec.subject.distribution,
        expected_version: context.spec.version.version,
        resolver: spec.resolver,
        artifacts_dir: context.artifactsDirectory,
        environment: spec.environment,
        timeout_seconds: spec.measurements.timeout_seconds,
      }).pipe(Effect.mapError((error) => new RunnerExecutionError({ message: error.message })));

      const observation = yield* measureImportTime(
        prepared,
        spec,
        context.artifactsDirectory,
        currentHost,
      ).pipe(Effect.provideService(ImportTimeProbe, probe));

      return yield* buildImportTimeResult(context, prepared, observation, spec.workload.name);
    }, Effect.scoped),
  };
});

export const runner = makeImportTimeRunner.pipe(Effect.provide(ImportTimeProbeLive));
