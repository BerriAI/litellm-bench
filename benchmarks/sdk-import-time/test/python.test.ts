import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { ProcessExecutor, ProcessExecutorLive } from "@litellm-bench/harness";
import { Effect, FileSystem, Path } from "effect";
import { currentHost } from "../src/config.js";
import { measureImportTime } from "../src/measurement.js";
import { ImportTimeProbe, ImportTimeProbeLive } from "../src/probe.js";
import { prepared, spec } from "./fixtures.js";

const withPython = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    R | ImportTimeProbe | ProcessExecutor | FileSystem.FileSystem | Path.Path
  >,
) =>
  effect.pipe(
    Effect.provide(ImportTimeProbeLive),
    Effect.provide(ProcessExecutorLive),
    Effect.provide(NodeServices.layer),
  );

const environment = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const executor = yield* ProcessExecutor;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "import-time-test-" });
  const { stdout } = yield* executor.execute({
    executable: "python3",
    args: ["-I", "-c", "import sys; print(sys.executable)"],
    cwd: workspace,
    timeoutMs: 5000,
  });
  const sitePackages = path.join(workspace, "site-packages");
  yield* fs.makeDirectory(sitePackages);
  return { ...prepared, python: stdout.trim(), workspace, site_packages: [sitePackages] };
});

it.live(
  "measures distinct isolated Python processes and collects importtime only afterward",
  () =>
    withPython(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const target = yield* environment;
      const marker = path.join(target.site_packages[0]!, "processes");
      const statement = `import os, sys; assert sys.flags.isolated == 1; open(${
        JSON.stringify(marker)
      }, 'a').write(str(os.getpid()) + '\\n')`;
      const raw = yield* measureImportTime(
        target,
        {
          ...spec,
          workload: { ...spec.workload, statement },
          measurements: { ...spec.measurements, importtime: true },
        },
        target.workspace,
        currentHost,
      );
      const pids = (yield* fs.readFileString(marker)).trim().split("\n");
      expect(new Set(pids).size).toBe(7);
      expect(raw.timing.warmup_samples_seconds).toHaveLength(2);
      expect(raw.timing.fresh_process.samples_seconds).toHaveLength(3);
      expect(raw.timing.fresh_process.samples_seconds.every((value) => value > 0)).toBe(true);
      expect(raw.size.installed_before_first_run.logical_bytes).toBe(0);
      expect(raw.size.first_run_logical_delta_bytes).toBe(pids[0]!.length + 1);
      const log = yield* fs.readFileString(path.join(target.workspace, "importtime.log"));
      expect(log).toContain("import time:");
      expect(raw.diagnostics.importtime).toEqual({
        path: "importtime.log",
        bytes: Buffer.byteLength(log),
      });
    })),
  10000,
);

it.live(
  "preserves real Python exceptions and subprocess timeout messages",
  () =>
    withPython(Effect.gen(function*() {
      const target = yield* environment;
      const probe = yield* ImportTimeProbe;
      for (
        const [statement, expected] of [
          ["raise RuntimeError('probe exploded')", "probe exploded"],
          ["import time; time.sleep(5)", "TimeoutExpired"],
        ]
      ) {
        const error = yield* Effect.flip(
          probe.measureBatch(
            target,
            {
              ...spec,
              workload: { ...spec.workload, statement: statement! },
              measurements: { ...spec.measurements, timeout_seconds: 1 },
            },
            "first",
            1,
          ),
        );
        expect(error._tag).toBe("RunnerExecutionError");
        expect(error.message).toContain(expected);
      }
    })),
  10000,
);
