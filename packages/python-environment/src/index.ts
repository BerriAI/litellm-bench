import { createHash } from "node:crypto";

import { ProcessExecutor } from "@litellm-bench/harness";
import {
  ByteSize,
  Context,
  Data,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  type Scope,
  Stream,
} from "effect";

export interface FileSize {
  readonly logical_bytes: number;
  readonly allocated_bytes: number | null;
}

export interface ResolverOptions {
  readonly index_url?: string;
  readonly extra_index_urls?: readonly string[];
  readonly find_links?: readonly string[];
  readonly binary_only?: boolean;
}

export interface CommandSpec {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly extend_environment?: boolean;
  readonly timeoutMs?: number;
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  readonly run: (command: CommandSpec) => Effect.Effect<CommandResult, unknown>;
}

export class PythonEnvironmentError extends Data.TaggedError("PythonEnvironmentError")<{
  readonly operation: string;
  readonly message: string;
}> {}

export const pythonProbeUrl = new URL("../assets/probe.py", import.meta.url);
export const timingSupervisorUrl = new URL("../assets/timing.py", import.meta.url);

export const resolverArguments = (resolver: ResolverOptions): readonly string[] => [
  ...(resolver.index_url === undefined ? [] : ["--index-url", resolver.index_url]),
  ...(resolver.extra_index_urls ?? []).flatMap((url) => ["--extra-index-url", url]),
  ...(resolver.find_links ?? []).flatMap((location) => ["--find-links", location]),
  ...(resolver.binary_only === true ? ["--only-binary=:all:"] : []),
];

export const combinedSize = (
  roots: string | readonly string[],
): Effect.Effect<FileSize, PythonEnvironmentError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const seenPaths = new Set<string>();
    const seenInodes = new Set<string>();
    let logicalBytes = 0;
    const visit = (path: string): Effect.Effect<void, unknown> =>
      Effect.gen(function*() {
        const absolute = pathService.resolve(path);
        if (seenPaths.has(absolute)) return;
        seenPaths.add(absolute);
        const linkTarget = yield* fs.readLink(absolute).pipe(Effect.option);
        if (Option.isSome(linkTarget)) {
          logicalBytes += new TextEncoder().encode(linkTarget.value).byteLength;
          if (!Number.isSafeInteger(logicalBytes)) {
            return yield* Effect.fail(
              new Error("Combined file size exceeds the safe integer range"),
            );
          }
          return;
        }
        const metadata = yield* fs.stat(absolute);
        if (metadata.type === "Directory") {
          for (const child of yield* fs.readDirectory(absolute)) {
            yield* visit(pathService.join(absolute, child));
          }
          return;
        }
        if (metadata.type !== "File" && metadata.type !== "SymbolicLink") {
          return yield* Effect.fail(new Error(`Unsupported filesystem entry: ${absolute}`));
        }
        const links = Option.getOrUndefined(metadata.nlink);
        const inodeNumber = Option.getOrUndefined(metadata.ino);
        if (metadata.type === "File" && links !== undefined && links > 1) {
          if (
            !Number.isSafeInteger(metadata.dev) || inodeNumber === undefined
            || !Number.isSafeInteger(inodeNumber) || inodeNumber === 0
          ) {
            return yield* Effect.fail(
              new Error(`Cannot identify hard-linked file safely: ${absolute}`),
            );
          }
          const inode = `${metadata.dev}:${inodeNumber}`;
          if (seenInodes.has(inode)) return;
          seenInodes.add(inode);
        }
        const size = Option.getOrUndefined(ByteSize.toNumber(metadata.size));
        if (size === undefined || !Number.isSafeInteger(size) || size < 0) {
          return yield* Effect.fail(
            new Error(`File size exceeds the safe integer range: ${absolute}`),
          );
        }
        logicalBytes += size;
        if (!Number.isSafeInteger(logicalBytes)) {
          return yield* Effect.fail(new Error("Combined file size exceeds the safe integer range"));
        }
      });
    for (const root of typeof roots === "string" ? [roots] : roots) yield* visit(root);
    // Allocation units and sparse-file accounting are not portable across supported hosts.
    return { logical_bytes: logicalBytes, allocated_bytes: null };
  }).pipe(
    Effect.mapError((error) =>
      new PythonEnvironmentError({
        operation: "measure-files",
        message: error instanceof Error ? error.message : String(error),
      })
    ),
  );

export interface PrepareSpec {
  readonly python: string;
  readonly requirement: string;
  readonly distribution: string;
  readonly resolver: ResolverOptions;
  readonly workspace: string;
  readonly artifacts_dir: string;
  readonly uv?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly expected_version: string;
  readonly timeout_seconds?: number;
}

export interface PreparedEnvironment {
  readonly workspace: string;
  readonly python: string;
  readonly site_packages: readonly string[];
  readonly installed_files: readonly string[];
  readonly downloads: string;
  readonly pip_report: string;
  readonly artifacts: ReadonlyArray<{
    readonly filename: string;
    readonly bytes: number;
    readonly sha256: string;
  }>;
  readonly package_artifact_bytes?: number;
  readonly package_version: string;
  readonly python_metadata: Readonly<Record<string, string>>;
  readonly uv_version: string;
  readonly pip_version: string;
}

const PipReport = Schema.Struct({
  install: Schema.Array(Schema.Struct({
    metadata: Schema.Struct({
      name: Schema.String,
      version: Schema.String,
    }),
    download_info: Schema.Struct({
      url: Schema.String,
    }),
  })),
});

const SitePackages = Schema.Array(Schema.String);

const InstalledFileInventory = Schema.Struct({
  paths: Schema.Array(Schema.String),
  missing: Schema.Array(Schema.String),
  outside: Schema.Array(Schema.String),
  nonfiles: Schema.Array(Schema.String),
});

const PythonMetadata = Schema.Record(Schema.String, Schema.String);

const decodeJsonDocument = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema));

const canonicalDistribution = (value: string): string =>
  value.replace(/[-_.]+/g, "_").toLowerCase();

export const sanitizedPythonEnvironment = (
  overrides: Readonly<Record<string, string>> = {},
  ambient: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    [...Object.entries(ambient), ...Object.entries(overrides)]
      .filter((entry): entry is [string, string] =>
        entry[1] !== undefined && !/^(?:PIP|UV)_/i.test(entry[0])
      ),
  );

const artifactFilename = (url: string): string | undefined => {
  const candidate = new URL(url).pathname.split("/").at(-1);
  return candidate === undefined ? undefined : decodeURIComponent(candidate);
};

const sha256File = (path: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem;
    const hash = createHash("sha256");
    yield* fs.stream(path).pipe(
      Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))),
    );
    return hash.digest("hex");
  });

interface ReportInstall {
  readonly filename: string;
  readonly name: string;
  readonly version: string;
}

const reportInstalls = (report: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem;
    const contents = yield* fs.readFileString(report);
    const decoded = yield* decodeJsonDocument(PipReport)(contents).pipe(
      Effect.mapError((error) =>
        new Error(
          error instanceof Error ? error.message : "pip report contains an invalid install entry",
        )
      ),
    );
    return yield* Effect.try({
      try: () =>
        decoded.install.map((install) => {
          const filename = artifactFilename(install.download_info.url);
          if (filename === undefined) {
            throw new Error("pip report install entry has no artifact filename");
          }
          return { filename, name: install.metadata.name, version: install.metadata.version };
        }),
      catch: (error) => error,
    });
  });

const subjectArtifactBytes = async (
  installs: readonly ReportInstall[],
  distribution: string,
  artifacts: ReadonlyArray<{ readonly filename: string; readonly bytes: number }>,
): Promise<number | undefined> => {
  const subject = canonicalDistribution(distribution);
  const filename = installs.find((install) => canonicalDistribution(install.name) === subject)
    ?.filename;
  return filename === undefined
    ? undefined
    : artifacts.find((artifact) => artifact.filename === filename)?.bytes;
};

const pythonPath = (path: Path.Path, environment: string): string =>
  process.platform === "win32"
    ? path.join(environment, "Scripts", "python.exe")
    : path.join(environment, "bin", "python");

export const prepareEnvironment = (
  runner: CommandRunner,
  spec: PrepareSpec,
): Effect.Effect<
  PreparedEnvironment,
  PythonEnvironmentError,
  FileSystem.FileSystem | Path.Path
> => {
  const environment = sanitizedPythonEnvironment(spec.environment);
  const timeoutMs = spec.timeout_seconds === undefined ? undefined : spec.timeout_seconds * 1_000;
  const run = (executable: string, args: readonly string[]) =>
    runner.run({
      executable,
      arguments: args,
      environment,
      extend_environment: false,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }).pipe(Effect.mapError((error) =>
      new PythonEnvironmentError({
        operation: `${executable} ${args[0] ?? ""}`.trim(),
        message: error instanceof Error ? error.message : String(error),
      })
    ));
  return Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const uv = spec.uv ?? "uv";
    const resolver = path.join(spec.workspace, "resolver");
    const target = path.join(spec.workspace, "target");
    const downloads = path.join(spec.workspace, "downloads");
    const uvCache = path.join(spec.workspace, "uv-cache");
    const uvArguments = ["--no-config", "--cache-dir", uvCache];
    const report = path.join(spec.artifacts_dir, "pip-report.json");
    yield* Effect.all([
      fs.makeDirectory(downloads, { recursive: true }),
      fs.makeDirectory(uvCache, { recursive: true }),
      fs.makeDirectory(spec.artifacts_dir, { recursive: true }),
    ], { concurrency: "unbounded", discard: true }).pipe(
      Effect.mapError((error) =>
        new PythonEnvironmentError({
          operation: "create-directories",
          message: error instanceof Error ? error.message : String(error),
        })
      ),
    );
    const uvVersion = yield* run(uv, ["--no-config", "--version"]);
    const resolved = yield* run(uv, ["--no-config", "python", "find", spec.python]);
    yield* run(uv, [
      ...uvArguments,
      "venv",
      "--seed",
      "--python",
      resolved.stdout.trim(),
      resolver,
    ]);
    const resolverPython = pythonPath(path, resolver);
    const pipVersion = yield* run(resolverPython, ["-m", "pip", "--isolated", "--version"]);
    yield* run(resolverPython, [
      "-m",
      "pip",
      "--isolated",
      "download",
      "--disable-pip-version-check",
      "--no-cache-dir",
      "--dest",
      downloads,
      ...resolverArguments(spec.resolver),
      spec.requirement,
    ]);
    yield* run(uv, [...uvArguments, "venv", "--python", resolved.stdout.trim(), target]);
    const targetPython = pythonPath(path, target);
    yield* run(resolverPython, [
      "-m",
      "pip",
      "--isolated",
      "install",
      "--disable-pip-version-check",
      "--dry-run",
      "--ignore-installed",
      "--no-index",
      "--find-links",
      downloads,
      "--report",
      report,
      ...(spec.resolver.binary_only === true ? ["--only-binary=:all:"] : []),
      spec.requirement,
    ]);
    yield* run(uv, [
      ...uvArguments,
      "pip",
      "install",
      "--python",
      targetPython,
      "--no-index",
      "--find-links",
      downloads,
      ...(spec.resolver.binary_only === true ? ["--only-binary=:all:"] : []),
      spec.requirement,
    ]);
    const sitePackagesResult = yield* run(targetPython, [
      "-I",
      "-c",
      "import json, site; print(json.dumps(site.getsitepackages()))",
    ]);
    const packageVersionResult = yield* run(targetPython, [
      "-I",
      "-c",
      "import importlib.metadata, sys; print(importlib.metadata.version(sys.argv[1]))",
      spec.distribution,
    ]);
    const pythonMetadataResult = yield* run(targetPython, [
      "-I",
      "-c",
      "import json, platform, sys; print(json.dumps({'version': platform.python_version(), 'implementation': platform.python_implementation(), 'cache_tag': sys.implementation.cache_tag, 'executable': sys.executable}))",
    ]);
    const installedFilesResult = yield* run(targetPython, [
      "-I",
      "-c",
      "import importlib.metadata as m, json, os, sys; root=os.path.realpath(sys.prefix); paths=[]; missing=[]; "
      + "[(missing.append(d.metadata.get('Name','<unknown>')) if d.files is None else paths.extend(os.path.abspath(d.locate_file(p)) for p in d.files)) for d in m.distributions()]; "
      + "outside=[p for p in paths if os.path.commonpath([root,os.path.realpath(p)]) != root]; "
      + "nonfiles=[p for p in paths if not (os.path.isfile(p) or os.path.islink(p))]; "
      + "print(json.dumps({'paths':sorted(set(paths)), 'missing':missing, 'outside':outside, 'nonfiles':nonfiles}))",
    ]);
    const inspected = yield* Effect.gen(function*() {
      const entries = yield* fs.readDirectory(downloads);
      const unexpected = spec.resolver.binary_only === true
        ? entries.filter((name) => !name.toLowerCase().endsWith(".whl"))
        : [];
      if (unexpected.length > 0) {
        return yield* Effect.fail(
          new Error(
            `Binary-only resolution produced non-wheel artifacts: ${unexpected.join(", ")}`,
          ),
        );
      }
      const files = entries.toSorted((left, right) => left.localeCompare(right));
      const artifacts = yield* Effect.forEach(files, (name) =>
        Effect.gen(function*() {
          const artifactPath = path.join(downloads, name);
          const info = yield* fs.stat(artifactPath);
          const bytes = Option.getOrUndefined(ByteSize.toNumber(info.size));
          if (info.type !== "File" || bytes === undefined) {
            return yield* Effect.fail(
              new Error(`Downloaded artifact is not a regular file: ${artifactPath}`),
            );
          }
          return {
            filename: name,
            bytes,
            sha256: yield* sha256File(artifactPath),
          };
        }), { concurrency: "unbounded" });
      const installs = yield* reportInstalls(report);
      const artifactNames = artifacts.map(({ filename }) => filename).toSorted();
      const reportNames = installs.map(({ filename }) => filename).toSorted();
      if (JSON.stringify(artifactNames) !== JSON.stringify(reportNames)) {
        return yield* Effect.fail(
          new Error(
            `pip report closure differs from downloaded wheel inventory: downloaded=${
              artifactNames.join(",")
            } report=${reportNames.join(",")}`,
          ),
        );
      }
      const subject = installs.filter(({ name }) =>
        canonicalDistribution(name) === canonicalDistribution(spec.distribution)
      );
      if (subject.length !== 1) {
        return yield* Effect.fail(
          new Error(
            `pip report does not identify exactly one ${spec.distribution} distribution`,
          ),
        );
      }
      if (subject[0]?.version !== spec.expected_version) {
        return yield* Effect.fail(
          new Error(
            `Requested ${spec.distribution} ${spec.expected_version}, but pip resolved ${
              subject[0]?.version ?? "no version"
            }`,
          ),
        );
      }
      return {
        sitePackages: sitePackagesResult.stdout,
        pythonMetadata: pythonMetadataResult.stdout,
        installedFiles: installedFilesResult.stdout,
        artifacts,
        packageArtifactBytes: yield* Effect.promise(() =>
          subjectArtifactBytes(installs, spec.distribution, artifacts)
        ),
      };
    }).pipe(
      Effect.mapError((error) =>
        new PythonEnvironmentError({
          operation: "inspect-environment",
          message: error instanceof Error ? error.message : String(error),
        })
      ),
    );
    const sitePackages = yield* decodeJsonDocument(SitePackages)(inspected.sitePackages).pipe(
      Effect.mapError(() =>
        new PythonEnvironmentError({
          operation: "inspect-site-packages",
          message: "Python returned an invalid site-packages list",
        })
      ),
    );
    const installedFiles = yield* decodeJsonDocument(InstalledFileInventory)(
      inspected.installedFiles,
    ).pipe(
      Effect.mapError(() =>
        new PythonEnvironmentError({
          operation: "inspect-installed-files",
          message: "Python returned an invalid installed-file inventory",
        })
      ),
    );
    if (installedFiles.missing.length > 0) {
      return yield* Effect.fail(
        new PythonEnvironmentError({
          operation: "inspect-installed-files",
          message: `Installed distributions lack RECORD file inventories: ${
            installedFiles.missing.join(", ")
          }`,
        }),
      );
    }
    if (installedFiles.outside.length > 0) {
      return yield* Effect.fail(
        new PythonEnvironmentError({
          operation: "inspect-installed-files",
          message: `Installed RECORD paths escape the target environment: ${
            installedFiles.outside.join(", ")
          }`,
        }),
      );
    }
    if (installedFiles.nonfiles.length > 0) {
      return yield* Effect.fail(
        new PythonEnvironmentError({
          operation: "inspect-installed-files",
          message: `Installed RECORD entries are missing or not files: ${
            installedFiles.nonfiles.join(", ")
          }`,
        }),
      );
    }
    if (packageVersionResult.stdout.trim() !== spec.expected_version) {
      return yield* Effect.fail(
        new PythonEnvironmentError({
          operation: "verify-version",
          message:
            `Requested ${spec.distribution} ${spec.expected_version}, but installed ${packageVersionResult.stdout.trim()}`,
        }),
      );
    }
    const pythonMetadata = yield* decodeJsonDocument(PythonMetadata)(inspected.pythonMetadata).pipe(
      Effect.mapError(() =>
        new PythonEnvironmentError({
          operation: "inspect-python",
          message: "Python returned invalid runtime metadata",
        })
      ),
    );
    return {
      workspace: spec.workspace,
      python: targetPython,
      site_packages: sitePackages,
      installed_files: installedFiles.paths,
      downloads,
      pip_report: report,
      artifacts: inspected.artifacts,
      ...(inspected.packageArtifactBytes === undefined
        ? {}
        : { package_artifact_bytes: inspected.packageArtifactBytes }),
      package_version: packageVersionResult.stdout.trim(),
      python_metadata: pythonMetadata,
      uv_version: uvVersion.stdout.trim(),
      pip_version: pipVersion.stdout.trim(),
    };
  });
};

export type ScopedPrepareSpec = Omit<PrepareSpec, "workspace">;

export interface PythonEnvironmentShape {
  readonly prepare: (
    spec: ScopedPrepareSpec,
  ) => Effect.Effect<PreparedEnvironment, PythonEnvironmentError, Scope.Scope>;
}

export class PythonEnvironment extends Context.Service<PythonEnvironment, PythonEnvironmentShape>()(
  "@litellm-bench/python-environment/PythonEnvironment",
) {}

const temporaryWorkspace = Effect.flatMap(
  FileSystem.FileSystem,
  (fs) => fs.makeTempDirectoryScoped({ prefix: "litellm-bench-sdk-" }),
).pipe(
  Effect.mapError((error) =>
    new PythonEnvironmentError({
      operation: "create-workspace",
      message: error instanceof Error ? error.message : String(error),
    })
  ),
);

export const PythonEnvironmentLive = Layer.effect(
  PythonEnvironment,
  Effect.gen(function*() {
    const executor = yield* ProcessExecutor;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner: CommandRunner = {
      run: (command) =>
        executor.execute({
          executable: command.executable,
          args: command.arguments,
          cwd: command.cwd ?? process.cwd(),
          ...(command.environment === undefined ? {} : { env: command.environment }),
          ...(command.extend_environment === undefined
            ? {}
            : { extendEnv: command.extend_environment }),
          ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
        }).pipe(Effect.map(({ stdout, stderr }) => ({ stdout, stderr }))),
    };
    return {
      prepare: (spec) =>
        Effect.flatMap(
          temporaryWorkspace.pipe(Effect.provideService(FileSystem.FileSystem, fs)),
          (workspace) =>
            prepareEnvironment(runner, {
              ...spec,
              workspace,
              uv: spec.uv ?? process.env.LITELLM_BENCH_UV ?? "uv",
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
            ),
        ),
    };
  }),
);
