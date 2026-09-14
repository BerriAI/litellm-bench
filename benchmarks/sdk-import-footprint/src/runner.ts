import {
  type BenchmarkRunner,
  type RunContext,
  RunnerExecutionError,
} from "@litellm-bench/harness";
import { PythonEnvironment } from "@litellm-bench/python-environment";
import { Effect } from "effect";
import { currentHost, decodeImportFootprintSpec } from "./config.js";
import { measureImportFootprint } from "./measurement.js";
import { ImportFootprintProbe, ImportFootprintProbeLive } from "./probe.js";
import { buildImportFootprintResult } from "./result.js";

export const makeImportFootprintRunner: Effect.Effect<
  BenchmarkRunner,
  never,
  PythonEnvironment | ImportFootprintProbe
> = Effect.gen(function*() {
  const environments = yield* PythonEnvironment;
  const probe = yield* ImportFootprintProbe;
  return {
    id: "sdk-import-footprint",
    run: Effect.fn("ImportFootprint.run")(function*(context: RunContext) {
      const spec = yield* decodeImportFootprintSpec(context);
      const prepare = (purpose: "disk-mutation" | "diagnostics") =>
        environments.prepare({
          python: spec.runtime.python,
          requirement: spec.subject.requirement,
          distribution: spec.subject.distribution,
          expected_version: context.spec.version.version,
          resolver: spec.resolver,
          artifacts_dir: `${context.artifactsDirectory}/${purpose}`,
          environment: spec.environment,
          timeout_seconds: spec.measurements.timeout_seconds,
        }).pipe(Effect.mapError((error) => new RunnerExecutionError({ message: error.message })));
      const diskPrepared = yield* prepare("disk-mutation");
      const diagnosticPrepared = yield* prepare("diagnostics");
      const observation = yield* measureImportFootprint(
        diskPrepared,
        diagnosticPrepared,
        spec,
        currentHost,
      ).pipe(
        Effect.provideService(ImportFootprintProbe, probe),
      );
      return yield* buildImportFootprintResult(context, diskPrepared, observation);
    }, Effect.scoped),
  };
});

export const runner = makeImportFootprintRunner.pipe(Effect.provide(ImportFootprintProbeLive));
