import { expect, it } from "@effect/vitest";
import {
  type Command,
  DeadlineExceeded,
  ProcessExecutor,
  type ProcessExecutorShape,
  ProcessFailure,
  ProcessStartError,
} from "@litellm-bench/harness";
import { Effect, FileSystem, Path, PlatformError } from "effect";
import { ImportTimeProbe, ImportTimeProbeLive } from "../src/probe.js";
import { prepared, spec } from "./fixtures.js";

const success = { exitCode: 0, stdout: "", stderr: "" };
const missing = PlatformError.systemError({
  _tag: "NotFound",
  module: "FileSystem",
  method: "readFileString",
  pathOrDescriptor: "response.json",
});
const setup = (
  response: string | undefined,
  execute: (command: Command) => ReturnType<ProcessExecutorShape["execute"]> = () =>
    Effect.succeed(success),
  fsOverrides: Partial<FileSystem.FileSystem> = {},
) =>
  ImportTimeProbe.pipe(
    Effect.provide(ImportTimeProbeLive),
    Effect.provide(Path.layer),
    Effect.provideService(ProcessExecutor, { execute }),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        writeFileString: () => Effect.void,
        readFileString: () =>
          response === undefined ? Effect.fail(missing) : Effect.succeed(response),
        ...fsOverrides,
      }),
    ),
  );

it.effect("writes the exact request and runs an isolated supervisor with a bounded deadline", () =>
  Effect.gen(function*() {
    const commands: Command[] = [];
    const writes: Array<[string, string]> = [];
    const probe = yield* setup(
      "{\"status\":\"ok\",\"samples_seconds\":[0.3,0.1,0.2]}",
      (command) =>
        Effect.sync(() => {
          commands.push(command);
          return success;
        }),
      {
        writeFileString: (path, content) =>
          Effect.sync(() => {
            writes.push([path, content]);
          }),
      },
    );
    const samples = yield* probe.measureBatch(
      prepared,
      { ...spec, environment: { SOME_FLAG: "1" } },
      "samples",
      3,
    );
    expect(samples).toEqual([0.3, 0.1, 0.2]);
    expect(writes[0]?.[0]).toBe("/workspace/samples-request.json");
    expect(JSON.parse(writes[0]![1])).toEqual({
      python: prepared.python,
      statement: "import litellm",
      timeout_seconds: 2,
      samples: 3,
      output_path: "/workspace/samples-response.json",
    });
    expect(commands[0]).toMatchObject({
      executable: prepared.python,
      cwd: prepared.workspace,
      timeoutMs: 16000,
      env: { SOME_FLAG: "1" },
    });
    expect(commands[0]?.args?.[0]).toBe("-I");
    expect(commands[0]?.args?.[1]).toMatch(/assets\/timing.py$/);
  }));

for (
  const [name, response] of [
    ["short batch", "{\"status\":\"ok\",\"samples_seconds\":[0.1]}"],
    ["long batch", "{\"status\":\"ok\",\"samples_seconds\":[0.1,0.2,0.3,0.4]}"],
    ["empty batch", "{\"status\":\"ok\",\"samples_seconds\":[]}"],
    ["negative duration", "{\"status\":\"ok\",\"samples_seconds\":[0.1,-1,0.2]}"],
    ["zero duration", "{\"status\":\"ok\",\"samples_seconds\":[0.1,0,0.2]}"],
    ["nonfinite duration", "{\"status\":\"ok\",\"samples_seconds\":[0.1,1e999,0.2]}"],
    ["malformed JSON", "{"],
    ["unknown fields", "{\"status\":\"ok\",\"samples_seconds\":[0.1,0.2,0.3],\"extra\":true}"],
    ["missing response", undefined],
  ] as const
) {
  it.effect(`rejects ${name}`, () =>
    Effect.gen(function*() {
      const probe = yield* setup(response);
      const error = yield* Effect.flip(probe.measureBatch(prepared, spec, "samples", 3));
      expect(error._tag).toBe("InvalidObservation");
      expect(error.message).toContain("samples:");
    }));
}

it.effect("reads structured Python failures even after a nonzero exit", () =>
  Effect.gen(function*() {
    const probe = yield* setup(
      "{\"status\":\"failed\",\"error\":{\"type\":\"ImportError\",\"message\":\"missing dependency\"}}",
      (command) =>
        Effect.fail(new ProcessFailure({ command, output: { ...success, exitCode: 1 } })),
    );
    expect(yield* Effect.flip(probe.measureBatch(prepared, spec, "first", 1)))
      .toMatchObject({
        _tag: "RunnerExecutionError",
        message: "first: ImportError: missing dependency",
      });
  }));

it.effect("retains completed samples and the failing index from a partial batch failure", () =>
  Effect.gen(function*() {
    const probe = yield* setup(
      JSON.stringify({
        status: "failed",
        error: { type: "RuntimeError", message: "process exited 7: ", sample_index: 3 },
        completed_samples_seconds: [0.31, 0.29],
      }),
      (command) =>
        Effect.fail(new ProcessFailure({ command, output: { ...success, exitCode: 1 } })),
    );
    expect(yield* Effect.flip(probe.measureBatch(prepared, spec, "samples", 20)))
      .toMatchObject({
        _tag: "RunnerExecutionError",
        message: "samples: RuntimeError: process exited 7: ",
        details: {
          phase: "samples",
          requested_samples: 20,
          failed_sample_index: 3,
          completed_samples_seconds: [0.31, 0.29],
        },
      });
  }));

it.effect("never accepts a successful payload from a failed process", () =>
  Effect.gen(function*() {
    const probe = yield* setup("{\"status\":\"ok\",\"samples_seconds\":[0.1]}", (command) =>
      Effect.fail(
        new ProcessFailure({ command, output: { ...success, exitCode: 1, stderr: "crashed" } }),
      ));
    expect(yield* Effect.flip(probe.measureBatch(prepared, spec, "first", 1)))
      .toMatchObject({ _tag: "RunnerExecutionError", message: "first: process exited 1: crashed" });
  }));

it.effect("retains stderr when the failed process writes no response", () =>
  Effect.gen(function*() {
    const probe = yield* setup(
      undefined,
      (command) =>
        Effect.fail(
          new ProcessFailure({
            command,
            output: { ...success, exitCode: 2, stderr: "supervisor missing" },
          }),
        ),
    );
    expect(yield* Effect.flip(probe.measureBatch(prepared, spec, "first", 1)))
      .toMatchObject({
        _tag: "RunnerExecutionError",
        message: "first: process exited 2: supervisor missing",
      });
  }));

it.effect("reports process start and deadline failures without reading stale responses", () =>
  Effect.gen(function*() {
    for (
      const makeError of [
        (command: Command) => new DeadlineExceeded({ command, timeoutMs: 1000 }),
        (command: Command) => new ProcessStartError({ command, cause: new Error("spawn failed") }),
      ]
    ) {
      const probe = yield* setup(undefined, (command) => Effect.fail(makeError(command)), {
        readFileString: () => Effect.die("must not read response"),
      });
      const error = yield* Effect.flip(probe.measureBatch(prepared, spec, "first", 1));
      expect(error._tag).toBe("RunnerExecutionError");
      expect(error.message).toMatch(/timed out after 1000 ms|spawn failed/);
    }
  }));

it.effect("does not start Python if the request cannot be written", () =>
  Effect.gen(function*() {
    const probe = yield* setup(undefined, () => Effect.die("must not execute"), {
      writeFileString: () => Effect.fail(missing),
    });
    expect((yield* Effect.flip(probe.measureBatch(prepared, spec, "first", 1)))._tag).toBe(
      "RunnerExecutionError",
    );
  }));
