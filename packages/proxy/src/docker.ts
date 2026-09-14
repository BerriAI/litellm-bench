import {
  type CommandOutput,
  ProcessExecutor,
  type ProcessExecutorShape,
  ProcessFailure,
} from "@litellm-bench/harness";
import { Context, Data, Effect, FileSystem, Layer, type Scope } from "effect";

export class DockerError extends Data.TaggedError("DockerError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface DockerMetadata {
  readonly version: string;
  readonly os: "linux";
  readonly architecture: "x86_64" | "arm64";
  readonly cgroupVersion: "2";
}

export interface DockerMount {
  readonly source: string;
  readonly target: string;
  readonly readOnly?: boolean;
}

export interface DockerPort {
  readonly hostAddress?: string;
  readonly hostPort: number;
  readonly containerPort: number;
}

export interface DockerContainerSpec {
  readonly name: string;
  readonly image: string;
  readonly network: string;
  readonly networkAliases?: ReadonlyArray<string>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly mounts?: ReadonlyArray<DockerMount>;
  readonly ports?: ReadonlyArray<DockerPort>;
  readonly cpus?: number;
  readonly cpuSet?: string;
  readonly memory?: string;
  readonly logDriver?: string;
  readonly command?: ReadonlyArray<string>;
  readonly logPath?: string;
}

export interface DockerContainer {
  readonly name: string;
  readonly exec: (
    args: ReadonlyArray<string>,
    options?: { readonly timeoutMs?: number },
  ) => Effect.Effect<CommandOutput, DockerError>;
}

export interface DockerEngineShape {
  readonly verify: Effect.Effect<DockerMetadata, DockerError>;
  readonly inspectImage: (image: string) => Effect.Effect<string, DockerError>;
  readonly network: (name: string) => Effect.Effect<string, DockerError, Scope.Scope>;
  readonly container: (
    spec: DockerContainerSpec,
  ) => Effect.Effect<DockerContainer, DockerError, Scope.Scope>;
}

export class DockerEngine extends Context.Service<DockerEngine, DockerEngineShape>()(
  "@litellm-bench/proxy/DockerEngine",
) {}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const normalizeArchitecture = (value: string): DockerMetadata["architecture"] | undefined => {
  switch (value) {
    case "amd64":
    case "x86_64":
      return "x86_64";
    case "arm64":
    case "aarch64":
      return "arm64";
    default:
      return undefined;
  }
};

export const parseDockerMetadata = (
  versionOutput: string,
  cgroupOutput: string,
): Effect.Effect<DockerMetadata, DockerError> => {
  const [version, os, rawArchitecture] = versionOutput.trim().split("\t");
  const architecture = rawArchitecture === undefined
    ? undefined
    : normalizeArchitecture(rawArchitecture);
  const cgroupVersion = cgroupOutput.trim();
  if (version === undefined || version.length === 0) {
    return Effect.fail(
      new DockerError({
        operation: "verify",
        message: "Docker returned an empty server version",
      }),
    );
  }
  if (os !== "linux") {
    return Effect.fail(
      new DockerError({
        operation: "verify",
        message: `Docker must use a Linux daemon; found ${os ?? "unknown"}`,
      }),
    );
  }
  if (architecture === undefined) {
    return Effect.fail(
      new DockerError({
        operation: "verify",
        message: `unsupported Docker architecture: ${rawArchitecture ?? "unknown"}`,
      }),
    );
  }
  if (cgroupVersion !== "2") {
    return Effect.fail(
      new DockerError({
        operation: "verify",
        message: `Docker must use cgroup v2; found ${cgroupVersion || "unknown"}`,
      }),
    );
  }
  return Effect.succeed({ version, os, architecture, cgroupVersion });
};

const portArgument = ({ hostAddress = "127.0.0.1", hostPort, containerPort }: DockerPort) =>
  `${hostAddress}:${hostPort}:${containerPort}`;

const mountArgument = ({ source, target, readOnly }: DockerMount) =>
  `${source}:${target}${readOnly === true ? ":ro" : ""}`;

export const containerRunArguments = (spec: DockerContainerSpec): ReadonlyArray<string> => [
  "run",
  "-d",
  "--rm",
  "--name",
  spec.name,
  "--network",
  spec.network,
  ...(spec.networkAliases ?? []).flatMap((alias) => ["--network-alias", alias]),
  ...(spec.cpus === undefined ? [] : ["--cpus", String(spec.cpus)]),
  ...(spec.cpuSet === undefined ? [] : ["--cpuset-cpus", spec.cpuSet]),
  ...(spec.memory === undefined ? [] : ["--memory", spec.memory]),
  ...(spec.logDriver === undefined ? [] : ["--log-driver", spec.logDriver]),
  ...Object.entries(spec.environment ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
  ...(spec.mounts ?? []).flatMap((mount) => ["-v", mountArgument(mount)]),
  ...(spec.ports ?? []).flatMap((port) => ["-p", portArgument(port)]),
  spec.image,
  ...(spec.command ?? []),
];

const emptyOutput: CommandOutput = { exitCode: 1, stdout: "", stderr: "" };

export const makeDockerEngine = (
  executor: ProcessExecutorShape,
  cwd: string,
  writeLog: (path: string, content: string) => Effect.Effect<void, DockerError>,
): DockerEngineShape => {
  const run = (
    args: ReadonlyArray<string>,
    timeoutMs: number,
  ): Effect.Effect<CommandOutput, DockerError> =>
    executor.execute({ executable: "docker", args, cwd, timeoutMs }).pipe(
      Effect.mapError((cause) =>
        new DockerError({
          operation: args.slice(0, 2).join(" "),
          message: errorMessage(cause),
          cause,
        })
      ),
    );

  const runAllowFailure = (
    args: ReadonlyArray<string>,
    timeoutMs: number,
  ): Effect.Effect<CommandOutput, DockerError> =>
    executor.execute({ executable: "docker", args, cwd, timeoutMs }).pipe(
      Effect.catchTag("ProcessFailure", (error: ProcessFailure) => Effect.succeed(error.output)),
      Effect.mapError((cause) =>
        new DockerError({
          operation: args.slice(0, 2).join(" "),
          message: errorMessage(cause),
          cause,
        })
      ),
    );

  const cleanupContainer = (spec: DockerContainerSpec) =>
    Effect.gen(function*() {
      if (spec.logPath !== undefined) {
        const output = yield* runAllowFailure(["logs", spec.name], 30_000).pipe(
          Effect.catch(() => Effect.succeed(emptyOutput)),
        );
        yield* writeLog(spec.logPath, output.stdout + output.stderr).pipe(Effect.ignore);
      }
      yield* runAllowFailure(["rm", "-f", spec.name], 30_000).pipe(Effect.ignore);
    });

  return {
    verify: Effect.gen(function*() {
      const version = yield* run([
        "version",
        "--format",
        "{{.Server.Version}}\t{{.Server.Os}}\t{{.Server.Arch}}",
      ], 30_000);
      const cgroup = yield* run(["info", "--format", "{{.CgroupVersion}}"], 30_000);
      return yield* parseDockerMetadata(version.stdout, cgroup.stdout);
    }),
    inspectImage: (image) =>
      run(["pull", image], 300_000).pipe(
        Effect.andThen(
          run(["image", "inspect", image, "--format", "{{.Id}}"], 30_000),
        ),
        Effect.map(({ stdout }) => stdout.trim()),
        Effect.flatMap((id) =>
          id.length > 0
            ? Effect.succeed(id)
            : Effect.fail(
              new DockerError({
                operation: "image inspect",
                message: `Docker returned an empty image ID for ${image}`,
              }),
            )
        ),
      ),
    network: (name) =>
      Effect.acquireRelease(
        run(["network", "create", name], 30_000).pipe(Effect.as(name)),
        () => runAllowFailure(["network", "rm", name], 30_000).pipe(Effect.ignore),
      ),
    container: (spec) =>
      Effect.acquireRelease(
        run(containerRunArguments(spec), 120_000).pipe(Effect.as(
          {
            name: spec.name,
            exec: (args, options) =>
              run(["exec", spec.name, ...args], options?.timeoutMs ?? 30_000),
          } satisfies DockerContainer,
        )),
        () => cleanupContainer(spec),
      ),
  };
};

export const DockerEngineLive = Layer.effect(
  DockerEngine,
  Effect.gen(function*() {
    const executor = yield* ProcessExecutor;
    const fs = yield* FileSystem.FileSystem;
    const cwd = process.cwd();
    return makeDockerEngine(
      executor,
      cwd,
      (path, content) =>
        fs.writeFileString(path, content).pipe(
          Effect.mapError((cause) =>
            new DockerError({ operation: "retain container log", message: cause.message, cause })
          ),
        ),
    );
  }),
);
