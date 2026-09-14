import * as NodeServices from "@effect/platform-node/NodeServices";
import { Context, Data, Effect, Layer, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

export interface Command {
  readonly executable: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly extendEnv?: boolean;
  readonly timeoutMs?: number;
}

export interface CommandOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class ProcessStartError extends Data.TaggedError("ProcessStartError")<{
  readonly command: Command;
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

export class ProcessFailure extends Data.TaggedError("ProcessFailure")<{
  readonly command: Command;
  readonly output: CommandOutput;
}> {
  override get message(): string {
    return this.output.stderr.trim() || this.output.stdout.trim()
      || `Process exited with code ${this.output.exitCode}`;
  }
}

export class DeadlineExceeded extends Data.TaggedError("DeadlineExceeded")<{
  readonly command: Command;
  readonly timeoutMs: number;
}> {
  override get message(): string {
    return `Process exceeded ${this.timeoutMs}ms deadline`;
  }
}

export type ProcessError = ProcessStartError | ProcessFailure | DeadlineExceeded;

export interface ProcessExecutorShape {
  readonly execute: (command: Command) => Effect.Effect<CommandOutput, ProcessError>;
}

export class ProcessExecutor extends Context.Service<ProcessExecutor, ProcessExecutorShape>()(
  "@litellm-bench/harness/ProcessExecutor",
) {}

const makeProcessExecutor = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const execute = (command: Command): Effect.Effect<CommandOutput, ProcessError> => {
    const execution = Effect.scoped(
      Effect.gen(function*() {
        const child = ChildProcess.make(command.executable, command.args ?? [], {
          cwd: command.cwd,
          env: command.env,
          extendEnv: command.extendEnv ?? command.env !== undefined,
          stdin: "ignore",
          forceKillAfter: "1 second",
        });
        const handle = yield* spawner.spawn(child).pipe(
          Effect.mapError((cause) => new ProcessStartError({ command, cause })),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.mapError((cause) => new ProcessStartError({ command, cause })));
        const output: CommandOutput = {
          exitCode: Number(exitCode),
          stdout,
          stderr,
        };
        return yield* output.exitCode === 0
          ? Effect.succeed(output)
          : Effect.fail(new ProcessFailure({ command, output }));
      }),
    );

    const timeoutMs = command.timeoutMs;
    return timeoutMs === undefined
      ? execution
      : execution.pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.fail(new DeadlineExceeded({ command, timeoutMs })),
        }),
      );
  };

  return ProcessExecutor.of({ execute });
});

export const ProcessExecutorLive = Layer.effect(ProcessExecutor, makeProcessExecutor).pipe(
  Layer.provide(NodeServices.layer),
);

export const runCommand = (
  command: Command,
): Effect.Effect<CommandOutput, ProcessError, ProcessExecutor> =>
  Effect.flatMap(ProcessExecutor, ({ execute: executeCommand }) => executeCommand(command));
