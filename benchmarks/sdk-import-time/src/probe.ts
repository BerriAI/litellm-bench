import { fileURLToPath } from "node:url";

import {
  type SdkBenchmarkSpec,
  type TimingProbeRequest,
  TimingProbeResponse,
} from "@litellm-bench/contracts";
import {
  InvalidObservation,
  type ProcessError,
  ProcessExecutor,
  RunnerExecutionError,
} from "@litellm-bench/harness";
import {
  combinedSize,
  type FileSize,
  type PreparedEnvironment,
  timingSupervisorUrl,
} from "@litellm-bench/python-environment";
import { ByteSize, Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";

type ProbeError = InvalidObservation | RunnerExecutionError;
type Phase = "first" | "warmups" | "samples";

export interface ImportTimeProbeShape {
  readonly measureBatch: (
    prepared: PreparedEnvironment,
    spec: SdkBenchmarkSpec,
    phase: Phase,
    samples: number,
  ) => Effect.Effect<readonly [number, ...number[]], ProbeError>;
  readonly installedSize: (
    paths: readonly string[],
  ) => Effect.Effect<FileSize, RunnerExecutionError>;
  readonly collectImporttime: (
    prepared: PreparedEnvironment,
    spec: SdkBenchmarkSpec,
    artifactsDirectory: string,
  ) => Effect.Effect<{ readonly path: string; readonly bytes: number }, RunnerExecutionError>;
}

export class ImportTimeProbe extends Context.Service<ImportTimeProbe, ImportTimeProbeShape>()(
  "@litellm-bench/benchmark-sdk-import-time/ImportTimeProbe",
) {}

const processError = (phase: string, error: ProcessError): RunnerExecutionError => {
  switch (error._tag) {
    case "ProcessFailure":
      return new RunnerExecutionError({
        message: `${phase}: process exited ${error.output.exitCode}: ${
          error.output.stderr || error.output.stdout
        }`,
      });
    case "DeadlineExceeded":
      return new RunnerExecutionError({
        message: `${phase}: process timed out after ${error.timeoutMs} ms`,
      });
    case "ProcessStartError":
      return new RunnerExecutionError({
        message: `${phase}: cannot start ${error.command.executable}: ${String(error.cause)}`,
      });
  }
};

export const ImportTimeProbeLive = Layer.effect(
  ImportTimeProbe,
  Effect.gen(function*() {
    const executor = yield* ProcessExecutor;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const decodeResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(TimingProbeResponse), {
      onExcessProperty: "error",
    });

    const measureBatch = Effect.fn("ImportTimeProbe.measureBatch")(function*(
      prepared: PreparedEnvironment,
      spec: SdkBenchmarkSpec,
      phase: Phase,
      samples: number,
    ) {
      const requestPath = path.join(prepared.workspace, `${phase}-request.json`);
      const outputPath = path.join(prepared.workspace, `${phase}-response.json`);
      const request: TimingProbeRequest = {
        python: prepared.python,
        statement: spec.workload.statement,
        timeout_seconds: spec.measurements.timeout_seconds,
        samples,
        output_path: outputPath,
      };
      yield* fs.writeFileString(requestPath, `${JSON.stringify(request, null, 2)}\n`).pipe(
        Effect.mapError((error) =>
          new RunnerExecutionError({
            message: `${phase}: cannot write ${requestPath}: ${error.message}`,
          })
        ),
      );
      // The supervisor writes structured failures before exiting nonzero.
      const command = {
        executable: prepared.python,
        args: ["-I", fileURLToPath(timingSupervisorUrl), requestPath],
        cwd: prepared.workspace,
        env: spec.environment,
        timeoutMs: (spec.measurements.timeout_seconds * samples + 10) * 1_000,
      };
      const output = yield* executor.execute(command).pipe(
        Effect.catchTag("ProcessFailure", (error) => Effect.succeed(error.output)),
        Effect.mapError((error) => processError(phase, error)),
      );
      const response = yield* fs.readFileString(outputPath).pipe(
        Effect.flatMap(decodeResponse),
        Effect.mapError((error) =>
          output.exitCode === 0
            ? new InvalidObservation({
              message: `${phase}: invalid response at ${outputPath}: ${error.message}`,
            })
            : new RunnerExecutionError({
              message: `${phase}: process exited ${output.exitCode}: ${
                output.stderr || error.message
              }`,
            })
        ),
      );
      if (response.status === "failed") {
        const failedIndex = response.error.sample_index;
        const completed = response.completed_samples_seconds;
        return yield* new RunnerExecutionError({
          message: `${phase}: ${response.error.type}: ${response.error.message}`,
          ...(failedIndex === undefined && completed === undefined ? {} : {
            details: {
              phase,
              requested_samples: samples,
              ...(failedIndex === undefined ? {} : { failed_sample_index: failedIndex }),
              ...(completed === undefined ? {} : { completed_samples_seconds: completed }),
            },
          }),
        });
      }
      if (output.exitCode !== 0) {
        return yield* new RunnerExecutionError({
          message: `${phase}: process exited ${output.exitCode}: ${output.stderr}`,
        });
      }
      if (
        response.samples_seconds.length !== samples
        || response.samples_seconds.some((value) => value <= 0)
      ) {
        return yield* new InvalidObservation({
          message: `${phase}: expected ${samples} positive finite samples, received ${
            JSON.stringify(response.samples_seconds)
          }`,
        });
      }
      return response.samples_seconds;
    });

    const collectImporttime = Effect.fn("ImportTimeProbe.collectImporttime")(function*(
      prepared: PreparedEnvironment,
      spec: SdkBenchmarkSpec,
      artifactsDirectory: string,
    ) {
      const { stderr } = yield* executor.execute({
        executable: prepared.python,
        args: ["-X", "importtime", "-I", "-c", spec.workload.statement],
        cwd: prepared.workspace,
        env: spec.environment,
        timeoutMs: spec.measurements.timeout_seconds * 1_000,
      }).pipe(Effect.mapError((error) => processError("importtime", error)));
      const outputPath = path.join(artifactsDirectory, "importtime.log");
      yield* fs.writeFileString(outputPath, stderr).pipe(
        Effect.mapError((error) =>
          new RunnerExecutionError({ message: `Cannot write ${outputPath}: ${error.message}` })
        ),
      );
      const info = yield* fs.stat(outputPath).pipe(
        Effect.mapError((error) =>
          new RunnerExecutionError({ message: `Cannot inspect ${outputPath}: ${error.message}` })
        ),
      );
      const bytes = Option.getOrUndefined(ByteSize.toNumber(info.size));
      if (bytes === undefined) {
        return yield* new RunnerExecutionError({
          message: `Cannot represent ${outputPath} size as a number`,
        });
      }
      return { path: "importtime.log", bytes };
    });

    return ImportTimeProbe.of({
      measureBatch,
      collectImporttime,
      installedSize: (paths) =>
        combinedSize(paths).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError((error) => new RunnerExecutionError({ message: error.message })),
        ),
    });
  }),
);
