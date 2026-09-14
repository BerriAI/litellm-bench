import { Effect, FileSystem, Layer, Path, Ref, Stdio, Terminal } from "effect";
import { CliConfig, CliError, CliOutput, Command, GlobalFlag } from "effect/unstable/cli";
import { ChildProcessSpawner } from "effect/unstable/process";

import { RunMetadataGenerator, RunnerRegistry } from "@litellm-bench/harness";
import { ProxyEnvironment } from "@litellm-bench/proxy";
import { makeCliCommand } from "./commands.js";
import { BenchmarkCatalog, CliResponse, errorResponse, ExitCode } from "./model.js";

const usage =
  "Usage: litellm-bench <list | describe | plan | run | run-version | smoke | validate | data | schema>";

const cliRuntimeLayer = Layer.mergeAll(
  Stdio.layerTest({}),
  CliConfig.layer({
    builtIns: CliConfig.defaults.builtIns.filter((flag) => flag !== GlobalFlag.Version),
  }),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      readInput: Effect.die("interactive input is unavailable"),
      readLine: Effect.die("interactive input is unavailable"),
      display: () => Effect.void,
    }),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("child process spawning is unavailable")),
  ),
);

const cliErrorResponse = (error: unknown): CliResponse => {
  const formatter = CliOutput.defaultFormatter({ colors: false });
  const detail = CliError.isCliError(error) ? formatter.formatCliError(error) : String(error);
  return errorResponse(ExitCode.UsageError, `${usage}\n${detail}\n`);
};

export const runCli = (
  args: ReadonlyArray<string>,
): Effect.Effect<
  CliResponse,
  never,
  | BenchmarkCatalog
  | FileSystem.FileSystem
  | Path.Path
  | RunnerRegistry
  | RunMetadataGenerator
  | ProxyEnvironment
> =>
  Effect.gen(function*() {
    const response = yield* Ref.make(errorResponse(ExitCode.UsageError, `${usage}\n`));
    const command = yield* makeCliCommand((value) => Ref.set(response, value));
    yield* Command.runWith(command, { version: "0.0.0", renderErrors: false })(args).pipe(
      Effect.catch((error) => Ref.set(response, cliErrorResponse(error))),
      Effect.provide(cliRuntimeLayer),
    );
    return yield* Ref.get(response);
  });
