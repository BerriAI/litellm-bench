import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Path } from "effect";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import type { Command, ProcessExecutorShape } from "@litellm-bench/harness";
import {
  containerRunArguments,
  DockerError,
  makeDockerEngine,
  parseDockerMetadata,
} from "./docker.js";

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
const writeFile = (location: string, contents: string) =>
  Effect.runPromise(platform.fs.writeFileString(location, contents));

const directories = new Set<string>();

afterEach(async () => {
  await Promise.all([...directories].map((path) => rm(path, { recursive: true, force: true })));
  directories.clear();
});

describe("DockerEngine", () => {
  it("builds docker arguments without shell parsing", () => {
    expect(containerRunArguments({
      name: "trial-proxy",
      image: "proxy:test",
      network: "bench",
      environment: { VALUE: "has spaces" },
      mounts: [{ source: "/a path/config.yaml", target: "/app/config.yaml", readOnly: true }],
      ports: [{ hostPort: 4020, containerPort: 4000 }],
      command: ["--config", "/app/config.yaml"],
    })).toEqual([
      "run",
      "-d",
      "--rm",
      "--name",
      "trial-proxy",
      "--network",
      "bench",
      "-e",
      "VALUE=has spaces",
      "-v",
      "/a path/config.yaml:/app/config.yaml:ro",
      "-p",
      "127.0.0.1:4020:4000",
      "proxy:test",
      "--config",
      "/app/config.yaml",
    ]);
  });

  it("pins containers to an explicit CPU set in addition to their quota", () => {
    expect(containerRunArguments({
      name: "pinned",
      image: "sha256:image",
      network: "bench",
      cpus: 1,
      cpuSet: "2",
    })).toContain("--cpuset-cpus");
    expect(containerRunArguments({
      name: "pinned",
      image: "sha256:image",
      network: "bench",
      cpus: 1,
      cpuSet: "2",
    })).toEqual(expect.arrayContaining(["--cpus", "1", "--cpuset-cpus", "2"]));
  });

  it("validates daemon metadata and cgroup v2", async () => {
    await expect(Effect.runPromise(parseDockerMetadata("27.1\tlinux\tamd64\n", "2\n")))
      .resolves.toEqual({
        version: "27.1",
        os: "linux",
        architecture: "x86_64",
        cgroupVersion: "2",
      });
    const error = await Effect.runPromise(
      parseDockerMetadata("27.1\tlinux\tamd64\n", "1\n").pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(DockerError);
    expect(error.message).toContain("cgroup v2");
  });

  it("releases containers and networks and retains logs on failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "litellm-bench-docker-"));
    directories.add(directory);
    const commands: Command[] = [];
    const executor: ProcessExecutorShape = {
      execute: (command) => {
        commands.push(command);
        return Effect.succeed({
          exitCode: 0,
          stdout: command.args?.[0] === "logs" ? "container output\n" : "ok\n",
          stderr: "",
        });
      },
    };
    const docker = makeDockerEngine(
      executor,
      directory,
      (path, content) =>
        Effect.tryPromise({
          try: () => writeFile(path, content),
          catch: (cause) =>
            new DockerError({ operation: "write log", message: String(cause), cause }),
        }),
    );
    const result = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const network = yield* docker.network("bench-network");
        yield* docker.container({
          name: "bench-container",
          image: "image:test",
          network,
          logPath: join(directory, "container.log"),
        });
        return yield* Effect.fail("measurement failed");
      })).pipe(Effect.flip),
    );

    expect(result).toBe("measurement failed");
    expect(commands.map(({ args }) => args?.slice(0, 3))).toEqual([
      ["network", "create", "bench-network"],
      ["run", "-d", "--rm"],
      ["logs", "bench-container"],
      ["rm", "-f", "bench-container"],
      ["network", "rm", "bench-network"],
    ]);
    expect(await readFile(join(directory, "container.log"), "utf8"))
      .toBe("container output\n");
  });
});
