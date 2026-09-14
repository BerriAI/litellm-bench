import {
  type DiagnosticProbe,
  type PythonProbeRequest,
  PythonProbeResponse,
  type SdkBenchmarkSpec,
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
  pythonProbeUrl,
} from "@litellm-bench/python-environment";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { fileURLToPath } from "node:url";

export interface ImportFootprintProbeShape {
  readonly installedSize: (
    paths: readonly string[],
  ) => Effect.Effect<FileSize, RunnerExecutionError>;
  readonly runFirstImport: (
    prepared: PreparedEnvironment,
    spec: SdkBenchmarkSpec,
  ) => Effect.Effect<void, RunnerExecutionError>;
  readonly collectDiagnostics: (
    prepared: PreparedEnvironment,
    spec: SdkBenchmarkSpec,
  ) => Effect.Effect<typeof DiagnosticProbe.Type, InvalidObservation | RunnerExecutionError>;
  readonly collectPeakRss: (
    prepared: PreparedEnvironment,
    spec: SdkBenchmarkSpec,
  ) => Effect.Effect<number, InvalidObservation | RunnerExecutionError>;
}
export class ImportFootprintProbe
  extends Context.Service<ImportFootprintProbe, ImportFootprintProbeShape>()(
    "@litellm-bench/benchmark-sdk-import-footprint/ImportFootprintProbe",
  )
{}

const processError = (operation: string, error: ProcessError): RunnerExecutionError => {
  switch (error._tag) {
    case "ProcessFailure":
      return new RunnerExecutionError({
        message: `${operation}: process exited ${error.output.exitCode}: ${
          error.output.stderr || error.output.stdout
        }`,
      });
    case "DeadlineExceeded":
      return new RunnerExecutionError({
        message: `${operation}: process timed out after ${error.timeoutMs} ms`,
      });
    case "ProcessStartError":
      return new RunnerExecutionError({
        message: `${operation}: cannot start ${error.command.executable}: ${String(error.cause)}`,
      });
  }
};

export const ImportFootprintProbeLive = Layer.effect(
  ImportFootprintProbe,
  Effect.gen(function*() {
    const executor = yield* ProcessExecutor;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const collectDiagnostics = Effect.fn("ImportFootprintProbe.collectDiagnostics")(
      function*(prepared: PreparedEnvironment, spec: SdkBenchmarkSpec) {
        const requestPath = path.join(prepared.workspace, "diagnostic-request.json");
        const outputPath = path.join(prepared.workspace, "diagnostic-response.json");
        const request: PythonProbeRequest = {
          workload: spec.workload,
          output_path: outputPath,
          collect_import_time: true,
          collect_modules: true,
          collect_peak_rss: false,
          collect_network: false,
        };
        yield* fs.writeFileString(requestPath, `${JSON.stringify(request, null, 2)}\n`).pipe(
          Effect.mapError((error) =>
            new RunnerExecutionError({
              message: `diagnostic: cannot write request: ${error.message}`,
            })
          ),
        );
        const command = {
          executable: prepared.python,
          args: ["-I", fileURLToPath(pythonProbeUrl), requestPath],
          cwd: prepared.workspace,
          env: spec.environment,
          timeoutMs: spec.measurements.timeout_seconds * 1_000,
        };
        const output = yield* executor.execute(command).pipe(
          Effect.catchTag("ProcessFailure", (error) => Effect.succeed(error.output)),
          Effect.mapError((error) => processError("diagnostic", error)),
        );
        const response = yield* fs.readFileString(outputPath).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.fromJsonString(PythonProbeResponse), {
              onExcessProperty: "error",
            }),
          ),
          Effect.mapError((error) =>
            output.exitCode === 0
              ? new InvalidObservation({
                message: `diagnostic: invalid response: ${error.message}`,
              })
              : new RunnerExecutionError({
                message: `diagnostic: process exited ${output.exitCode}: ${
                  output.stderr || error.message
                }`,
              })
          ),
        );
        if (response.status === "failed") {
          return yield* new RunnerExecutionError({
            message: `diagnostic: ${response.error.type}: ${response.error.message}`,
          });
        }
        if (output.exitCode !== 0) {
          return yield* new RunnerExecutionError({
            message: `diagnostic: process exited ${output.exitCode}: ${output.stderr}`,
          });
        }
        const { import_only_seconds: duration, new_module_count: modules } = response.observation;
        if (duration === undefined || duration <= 0 || modules === undefined) {
          return yield* new InvalidObservation({
            message: "diagnostic: missing or invalid import duration or module count",
          });
        }
        return response.observation;
      },
    );
    return ImportFootprintProbe.of({
      installedSize: (paths) =>
        combinedSize(paths).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError((error) => new RunnerExecutionError({ message: error.message })),
        ),
      runFirstImport: (prepared, spec) =>
        executor.execute({
          executable: prepared.python,
          args: ["-I", "-c", spec.workload.statement],
          cwd: prepared.workspace,
          env: spec.environment,
          timeoutMs: spec.measurements.timeout_seconds * 1_000,
        }).pipe(Effect.mapError((error) => processError("first import", error)), Effect.asVoid),
      collectDiagnostics,
      collectPeakRss: (prepared, spec) =>
        executor.execute({
          executable: "/usr/bin/time",
          args: [
            "-f",
            "LITELLM_BENCH_MAX_RSS_KIB=%M",
            prepared.python,
            "-I",
            "-c",
            spec.workload.statement,
          ],
          cwd: prepared.workspace,
          env: spec.environment,
          timeoutMs: spec.measurements.timeout_seconds * 1_000,
        }).pipe(
          Effect.mapError((error) => processError("external RSS", error)),
          Effect.flatMap(({ stderr }) => {
            const value = Number(stderr.match(/LITELLM_BENCH_MAX_RSS_KIB=(\d+)/)?.[1]);
            return Number.isSafeInteger(value) && value > 0
              ? Effect.succeed(value * 1_024)
              : Effect.fail(new InvalidObservation({ message: "external RSS: missing max RSS" }));
          }),
        ),
    });
  }),
);
