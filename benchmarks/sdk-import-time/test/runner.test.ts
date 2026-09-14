import { expect, it } from "@effect/vitest";
import { InvalidObservation, RunnerExecutionError } from "@litellm-bench/harness";
import { PythonEnvironment, PythonEnvironmentError } from "@litellm-bench/python-environment";
import { Deferred, Effect, Fiber } from "effect";
import { ImportTimeProbe, type ImportTimeProbeShape } from "../src/probe.js";
import { makeImportTimeRunner } from "../src/runner.js";
import { context, prepared } from "./fixtures.js";

const makeHarness = (overrides: Partial<ImportTimeProbeShape> = {}) => {
  const events: string[] = [];
  let sizeReads = 0;
  const probe: ImportTimeProbeShape = {
    installedSize: () =>
      Effect.sync(() => {
        events.push("size");
        return { logical_bytes: sizeReads++ === 0 ? 100 : 150, allocated_bytes: null };
      }),
    measureBatch: (_, __, phase) =>
      Effect.sync(() => {
        events.push(phase);
        return phase === "first"
          ? [9] as const
          : phase === "warmups"
          ? [8, 7] as const
          : [0.3, 0.1, 0.2] as const;
      }),
    collectImporttime: () =>
      Effect.sync(() => {
        events.push("importtime");
        return { path: "importtime.log", bytes: 20 };
      }),
    ...overrides,
  };
  const runner = makeImportTimeRunner.pipe(
    Effect.provideService(ImportTimeProbe, probe),
    Effect.provideService(PythonEnvironment, {
      prepare: () =>
        Effect.acquireRelease(
          Effect.sync(() => {
            events.push("prepare");
            return prepared;
          }),
          () =>
            Effect.sync(() => {
              events.push("release");
            }),
        ),
    }),
  );
  return { runner, events };
};

it.effect("retains ordered samples, excludes warmups, projects milliseconds, and closes the run scope", () =>
  Effect.gen(function*() {
    const { runner, events } = makeHarness();
    const result = yield* (yield* runner).run(context);
    expect(events).toEqual(["prepare", "size", "first", "size", "warmups", "samples", "release"]);
    expect(result.status).toBe("ok");
    expect(result.metrics.map(({ id, value }) => [id, value])).toEqual([
      ["import.median", 200],
      ["import.p95", 300],
      ["import.minimum", 100],
      ["import.maximum", 300],
      ["import.first", 9000],
    ]);
    expect(
      result.trials.map((
        trial,
      ) => [trial.id, trial.attempt, trial.scenario, trial.measurements.import_duration_ms]),
    )
      .toEqual([["fresh-import-1", 1, "root-import", 300], [
        "fresh-import-2",
        2,
        "root-import",
        100,
      ], ["fresh-import-3", 3, "root-import", 200]]);
    expect(result.analyses[0]?.payload.summary).toEqual({
      attempt_count: 3,
      minimum: 100,
      median: 200,
      p95: 300,
      maximum: 300,
    });
    expect(result.apparatus).toMatchObject({
      python_version: "3.12.0",
      python_implementation: "CPython",
    });
    expect(result.details?.size).toEqual({
      installed_before_first_run: { logical_bytes: 100 },
      installed_after_first_run: { logical_bytes: 150 },
      first_run_logical_delta_bytes: 50,
    });
    expect(result.case_id).toBe(context.spec.case_id);
  }));

it.effect("skips zero warmups and runs optional diagnostics after all timing", () =>
  Effect.gen(function*() {
    const { runner, events } = makeHarness();
    yield* (yield* runner).run({
      ...context,
      spec: {
        ...context.spec,
        job: {
          ...context.spec.job,
          config: {
            ...context.spec.job.config,
            measurements: {
              ...context.spec.job.config.measurements as object,
              warmups: 0,
              importtime: true,
            },
          },
        },
      },
    });
    expect(events).toEqual([
      "prepare",
      "size",
      "first",
      "size",
      "samples",
      "importtime",
      "release",
    ]);
  }));

it.effect("rejects invalid configuration before resource acquisition", () =>
  Effect.gen(function*() {
    const { runner, events } = makeHarness();
    const error = yield* Effect.flip(
      (yield* runner).run({
        ...context,
        spec: { ...context.spec, job: { ...context.spec.job, config: {} } },
      }),
    );
    expect(error._tag).toBe("InvalidRunnerConfig");
    expect(events).toEqual([]);
  }));

for (
  const failure of [
    new InvalidObservation({ message: "bad probe" }),
    new RunnerExecutionError({ message: "timeout" }),
  ]
) {
  it.effect(`releases resources after ${failure._tag}`, () =>
    Effect.gen(function*() {
      const { runner, events } = makeHarness({ measureBatch: () => Effect.fail(failure) });
      const error = yield* Effect.flip((yield* runner).run(context));
      expect(error).toBe(failure);
      expect(events).toEqual(["prepare", "size", "release"]);
    }));
}

it.effect("releases the environment when interrupted during a probe", () =>
  Effect.gen(function*() {
    const started = yield* Deferred.make<void>();
    const { runner, events } = makeHarness({
      measureBatch: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    });
    const fiber = yield* (yield* runner).run(context).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    expect(events).toEqual(["prepare", "size", "release"]);
  }));

it.effect("maps preparation failures into the runner error channel", () =>
  Effect.gen(function*() {
    const runner = yield* makeImportTimeRunner.pipe(
      Effect.provideService(ImportTimeProbe, {
        installedSize: () => Effect.die("unreachable"),
        measureBatch: () => Effect.die("unreachable"),
        collectImporttime: () => Effect.die("unreachable"),
      }),
      Effect.provideService(PythonEnvironment, {
        prepare: () =>
          Effect.fail(
            new PythonEnvironmentError({ operation: "install", message: "wheel unavailable" }),
          ),
      }),
    );
    expect(yield* Effect.flip(runner.run(context))).toMatchObject({
      _tag: "RunnerExecutionError",
      message: "wheel unavailable",
    });
  }));
