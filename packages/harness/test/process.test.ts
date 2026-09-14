import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Path } from "effect";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { DeadlineExceeded, ProcessExecutorLive, ProcessFailure, runCommand } from "../src/index.js";

const platform = await Effect.runPromise(
  Effect.all({ fs: FileSystem.FileSystem, path: Path.Path }).pipe(
    Effect.provide(NodeServices.layer),
  ),
);
const join = platform.path.join;
const mkdtemp = (prefix: string) =>
  Effect.runPromise(platform.fs.makeTempDirectory({
    directory: platform.path.dirname(prefix),
    prefix: platform.path.basename(prefix),
  }));
const readFile = (location: string, _encoding: "utf8") =>
  Effect.runPromise(platform.fs.readFileString(location));
const rm = (location: string, options: { recursive: boolean; force: boolean }) =>
  Effect.runPromise(platform.fs.remove(location, options));

const directories = new Set<string>();

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "litellm-bench-process-"));
  directories.add(directory);
  return directory;
};

const waitForFile = async (path: string): Promise<string> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
};

const waitForProcessExit = async (pid: number): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch {
      return;
    }
  }
  throw new Error(`Process ${pid} remained alive`);
};

afterEach(async () => {
  await Promise.all(
    [...directories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  directories.clear();
});

describe("ProcessExecutorLive", () => {
  it("captures successful output", async () => {
    const directory = await temporaryDirectory();
    const output = await Effect.runPromise(
      runCommand({
        executable: process.execPath,
        args: ["-e", "process.stdout.write('ready')"],
        cwd: directory,
      }).pipe(Effect.provide(ProcessExecutorLive)),
    );

    expect(output).toEqual({ exitCode: 0, stdout: "ready", stderr: "" });
  });

  it("returns process failures with diagnostics", async () => {
    const directory = await temporaryDirectory();
    const failure = await Effect.runPromise(
      runCommand({
        executable: process.execPath,
        args: ["-e", "process.stderr.write('broken'); process.exit(7)"],
        cwd: directory,
      }).pipe(Effect.provide(ProcessExecutorLive), Effect.flip),
    );

    expect(failure).toBeInstanceOf(ProcessFailure);
    expect((failure as ProcessFailure).output).toEqual({
      exitCode: 7,
      stdout: "",
      stderr: "broken",
    });
  });

  it("can replace rather than extend the ambient environment", async () => {
    const directory = await temporaryDirectory();
    process.env.LITELLM_BENCH_AMBIENT_TEST = "ambient";
    try {
      const output = await Effect.runPromise(
        runCommand({
          executable: process.execPath,
          args: [
            "-e",
            "process.stdout.write(JSON.stringify({ambient:process.env.LITELLM_BENCH_AMBIENT_TEST,explicit:process.env.LITELLM_BENCH_EXPLICIT_TEST}))",
          ],
          cwd: directory,
          env: { LITELLM_BENCH_EXPLICIT_TEST: "explicit" },
          extendEnv: false,
        }).pipe(Effect.provide(ProcessExecutorLive)),
      );
      expect(JSON.parse(output.stdout)).toEqual({ explicit: "explicit" });
    } finally {
      delete process.env.LITELLM_BENCH_AMBIENT_TEST;
    }
  });

  it("kills and reaps the process group on cancellation", async () => {
    const directory = await temporaryDirectory();
    const marker = join(directory, "grandchild.pid");
    const controller = new AbortController();
    const execution = Effect.runPromise(
      runCommand({
        executable: process.execPath,
        args: [
          "-e",
          `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']); require('node:fs').writeFileSync(${
            JSON.stringify(marker)
          }, String(child.pid)); setInterval(() => {}, 1000)`,
        ],
        cwd: directory,
      }).pipe(Effect.provide(ProcessExecutorLive)),
      { signal: controller.signal },
    );
    const grandchildPid = Number(await waitForFile(marker));

    controller.abort();
    await expect(execution).rejects.toBeDefined();
    await waitForProcessExit(grandchildPid);
  });

  it("reports deadlines after killing and reaping the process", async () => {
    const directory = await temporaryDirectory();
    const marker = join(directory, "child.pid");
    const failure = await Effect.runPromise(
      runCommand({
        executable: process.execPath,
        args: [
          "-e",
          `require('node:fs').writeFileSync(${
            JSON.stringify(marker)
          }, String(process.pid)); setInterval(() => {}, 1000)`,
        ],
        cwd: directory,
        timeoutMs: 50,
      }).pipe(Effect.provide(ProcessExecutorLive), Effect.flip),
    );
    const pid = Number(await waitForFile(marker));

    expect(failure).toBeInstanceOf(DeadlineExceeded);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
