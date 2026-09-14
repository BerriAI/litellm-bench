import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Path } from "effect";
import { describe, expect, it } from "vitest";

import {
  combinedSize,
  type CommandSpec,
  prepareEnvironment,
  pythonProbeUrl,
  resolverArguments,
  sanitizedPythonEnvironment,
  timingSupervisorUrl,
} from "./index.js";

const platform = await Effect.runPromise(
  Effect.all({ fs: FileSystem.FileSystem, path: Path.Path }).pipe(
    Effect.provide(NodeServices.layer),
  ),
);
const join = platform.path.join;
const link = (from: string, to: string) => Effect.runPromise(platform.fs.link(from, to));
const mkdir = (location: string) => Effect.runPromise(platform.fs.makeDirectory(location));
const mkdtemp = (prefix: string) =>
  Effect.runPromise(platform.fs.makeTempDirectory({
    directory: platform.path.dirname(prefix),
    prefix: platform.path.basename(prefix),
  }));
const readFile = (location: string, _encoding: "utf8") =>
  Effect.runPromise(platform.fs.readFileString(location));
const rm = (location: string, options: { recursive: boolean; force: boolean }) =>
  Effect.runPromise(platform.fs.remove(location, options));
const symlink = (from: string, to: string) => Effect.runPromise(platform.fs.symlink(from, to));
const writeFile = (location: string, contents: string) =>
  Effect.runPromise(platform.fs.writeFileString(location, contents));
const runPlatform = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.runPromise(effect.pipe(
    Effect.provideService(FileSystem.FileSystem, platform.fs),
    Effect.provideService(Path.Path, platform.path),
  ));

const executeFile = promisify(execFile);

describe("python environments", () => {
  it("renders resolver flags without shell parsing", () => {
    expect(resolverArguments({
      index_url: "https://index.test/simple",
      extra_index_urls: ["https://extra.test/simple"],
      find_links: ["a path/wheels"],
      binary_only: true,
    })).toEqual([
      "--index-url",
      "https://index.test/simple",
      "--extra-index-url",
      "https://extra.test/simple",
      "--find-links",
      "a path/wheels",
      "--only-binary=:all:",
    ]);
  });

  it("measures nested logical bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "litellm-bench-size-"));
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "one"), "123");
    await writeFile(join(root, "nested", "two"), "45678");
    await link(join(root, "one"), join(root, "one-hardlink"));
    await symlink("one", join(root, "one-symlink"));
    const size = await Effect.runPromise(
      combinedSize(root).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(size.logical_bytes).toBe(11);
    expect(size.allocated_bytes).toBeNull();
  });

  it("removes ambient and requested pip/uv configuration", () => {
    expect(sanitizedPythonEnvironment(
      { PIP_INDEX_URL: "https://override.invalid", UV_CONFIG_FILE: "/override", KEEP: "override" },
      {
        PIP_EXTRA_INDEX_URL: "https://ambient.invalid",
        UV_INDEX_URL: "https://ambient.invalid",
        KEEP: "ambient",
        PATH: "/bin",
      },
    )).toEqual({ KEEP: "override", PATH: "/bin" });
  });

  it("fails when an installed path cannot be inspected", async () => {
    const root = await mkdtemp(join(tmpdir(), "litellm-bench-missing-size-"));
    await expect(Effect.runPromise(
      combinedSize(join(root, "missing")).pipe(
        Effect.provide(NodeServices.layer),
        Effect.flip,
      ),
    )).resolves.toMatchObject({
      _tag: "PythonEnvironmentError",
      operation: "measure-files",
    });
  });

  it("isolates preparation and rejects a resolved version mismatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "litellm-bench-environment-"));
    const workspace = join(root, "workspace");
    const artifactsDirectory = join(root, "artifacts");
    await mkdir(workspace);
    const commands: CommandSpec[] = [];
    const runner = {
      run: (command: CommandSpec) =>
        Effect.promise(async () => {
          commands.push(command);
          const destinationIndex = command.arguments.indexOf("--dest");
          if (destinationIndex >= 0) {
            const destination = command.arguments[destinationIndex + 1] as string;
            await writeFile(join(destination, "litellm-1.0-py3-none-any.whl"), "wheel");
          }
          const reportIndex = command.arguments.indexOf("--report");
          if (reportIndex >= 0) {
            const report = command.arguments[reportIndex + 1] as string;
            await writeFile(
              report,
              JSON.stringify({
                version: "1",
                pip_version: "24.0",
                install: [{
                  metadata: { name: "litellm", version: "1.0.0", summary: "extra" },
                  download_info: {
                    url: "file:///downloads/litellm-1.0-py3-none-any.whl",
                    archive_info: { hash: "sha256=abc" },
                  },
                  requested: true,
                }],
              }),
            );
          }
          const stdout = command.executable === "uv" && command.arguments.includes("--version")
            ? "uv 1.0\n"
            : command.executable === "uv" && command.arguments.includes("python")
                && command.arguments.includes("find")
            ? "/python\n"
            : command.arguments.includes("--version")
            ? "pip 1.0\n"
            : command.arguments.some((argument) => argument.includes("site.getsitepackages"))
            ? "[\"/target/site-packages\"]\n"
            : command.arguments.some((argument) => argument.includes("m.distributions"))
            ? "{\"paths\":[\"/target/site-packages/litellm.py\",\"/target/bin/litellm\"],\"missing\":[],\"outside\":[],\"nonfiles\":[]}\n"
            : command.arguments.some((argument) => argument.includes("importlib.metadata"))
            ? "1.0.0\n"
            : command.arguments.some((argument) => argument.includes("platform.python_version"))
            ? "{\"version\":\"3.12.0\",\"implementation\":\"CPython\",\"cache_tag\":\"cpython-312\",\"executable\":\"/target/bin/python\"}\n"
            : "";
          return { stdout, stderr: "" };
        }),
    };
    try {
      const prepareSpec = {
        python: "3.12",
        requirement: "litellm==1.0",
        distribution: "litellm",
        expected_version: "1.0.0",
        resolver: { binary_only: true },
        workspace,
        artifacts_dir: artifactsDirectory,
        timeout_seconds: 7,
      } as const;
      const prepared = await runPlatform(prepareEnvironment(runner, prepareSpec));
      expect(prepared.python).toContain("/target/bin/python");
      expect(prepared.site_packages).toEqual(["/target/site-packages"]);
      expect(prepared.package_version).toBe("1.0.0");
      expect(prepared.package_artifact_bytes).toBe(5);
      expect(prepared.artifacts[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(prepared.installed_files).toContain("/target/bin/litellm");
      expect(commands.some((command) => command.arguments.includes("--dry-run"))).toBe(true);
      expect(commands.some((command) => command.arguments.includes("--no-index"))).toBe(true);
      expect(commands.every((command) => command.timeoutMs === 7_000)).toBe(true);
      expect(commands.every((command) => command.extend_environment === false)).toBe(true);
      expect(
        commands.every((command) =>
          Object.keys(command.environment ?? {}).every((key) => !/^(PIP|UV)_/i.test(key))
        ),
      ).toBe(true);
      expect(
        commands.filter((command) => command.executable === "uv").every((command) =>
          command.arguments[0] === "--no-config"
        ),
      ).toBe(true);
      expect(
        commands.filter((command) => command.arguments.includes("pip")).every((command) =>
          command.executable === "uv" || command.arguments.includes("--isolated")
        ),
      ).toBe(true);
      await expect(runPlatform(prepareEnvironment(runner, {
        ...prepareSpec,
        expected_version: "2.0.0",
      }))).rejects.toMatchObject({
        _tag: "PythonEnvironmentError",
        message: "Requested litellm 2.0.0, but pip resolved 1.0.0",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed Python inspection documents with existing error categories", async () => {
    const prepareSpec = {
      python: "3.12",
      requirement: "litellm==1.0",
      distribution: "litellm",
      expected_version: "1.0.0",
      resolver: { binary_only: true },
    } as const;
    const validReport = JSON.stringify({
      version: "1",
      install: [{
        metadata: { name: "litellm", version: "1.0.0", summary: "extra" },
        download_info: {
          url: "file:///downloads/litellm-1.0-py3-none-any.whl",
          archive_info: {},
        },
      }],
    });
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly report?: string;
      readonly sitePackages?: string;
      readonly installedFiles?: string;
      readonly pythonMetadata?: string;
      readonly operation: string;
      readonly message?: string | RegExp;
    }> = [
      {
        name: "invalid pip report JSON",
        report: "{",
        operation: "inspect-environment",
      },
      {
        name: "invalid pip report install entry",
        report: JSON.stringify({
          install: [{ metadata: { name: 1, version: "1.0.0" }, download_info: { url: "x" } }],
        }),
        operation: "inspect-environment",
      },
      {
        name: "non-array site-packages",
        sitePackages: "{}\n",
        operation: "inspect-site-packages",
        message: "Python returned an invalid site-packages list",
      },
      {
        name: "non-string site-packages entry",
        sitePackages: "[1]\n",
        operation: "inspect-site-packages",
        message: "Python returned an invalid site-packages list",
      },
      {
        name: "invalid installed-file inventory",
        installedFiles: "[]\n",
        operation: "inspect-installed-files",
        message: "Python returned an invalid installed-file inventory",
      },
      {
        name: "non-string installed-file path",
        installedFiles: "{\"paths\":[1],\"missing\":[],\"outside\":[],\"nonfiles\":[]}\n",
        operation: "inspect-installed-files",
        message: "Python returned an invalid installed-file inventory",
      },
      {
        name: "array python metadata",
        pythonMetadata: "[\"3.12.0\"]\n",
        operation: "inspect-python",
        message: "Python returned invalid runtime metadata",
      },
      {
        name: "non-string python metadata value",
        pythonMetadata: "{\"version\":3}\n",
        operation: "inspect-python",
        message: "Python returned invalid runtime metadata",
      },
    ];
    for (const candidate of cases) {
      const root = await mkdtemp(
        join(tmpdir(), `litellm-bench-${candidate.name.replace(/\s+/g, "-")}-`),
      );
      const workspace = join(root, "workspace");
      const artifactsDirectory = join(root, "artifacts");
      await mkdir(workspace);
      const runner = {
        run: (command: CommandSpec) =>
          Effect.promise(async () => {
            const destinationIndex = command.arguments.indexOf("--dest");
            if (destinationIndex >= 0) {
              await writeFile(
                join(
                  command.arguments[destinationIndex + 1] as string,
                  "litellm-1.0-py3-none-any.whl",
                ),
                "wheel",
              );
            }
            const reportIndex = command.arguments.indexOf("--report");
            if (reportIndex >= 0) {
              await writeFile(
                command.arguments[reportIndex + 1] as string,
                candidate.report ?? validReport,
              );
            }
            const stdout = command.executable === "uv" && command.arguments.includes("--version")
              ? "uv 1.0\n"
              : command.executable === "uv" && command.arguments.includes("python")
                  && command.arguments.includes("find")
              ? "/python\n"
              : command.arguments.includes("--version")
              ? "pip 1.0\n"
              : command.arguments.some((argument) => argument.includes("site.getsitepackages"))
              ? candidate.sitePackages ?? "[\"/target/site-packages\"]\n"
              : command.arguments.some((argument) => argument.includes("m.distributions"))
              ? candidate.installedFiles
                ?? "{\"paths\":[\"/target/site-packages/litellm.py\"],\"missing\":[],\"outside\":[],\"nonfiles\":[]}\n"
              : command.arguments.some((argument) => argument.includes("importlib.metadata"))
              ? "1.0.0\n"
              : command.arguments.some((argument) => argument.includes("platform.python_version"))
              ? candidate.pythonMetadata
                ?? "{\"version\":\"3.12.0\",\"implementation\":\"CPython\"}\n"
              : "";
            return { stdout, stderr: "" };
          }),
      };
      try {
        await expect(runPlatform(prepareEnvironment(runner, {
          ...prepareSpec,
          workspace,
          artifacts_dir: artifactsDirectory,
        }))).rejects.toMatchObject({
          _tag: "PythonEnvironmentError",
          operation: candidate.operation,
          ...(candidate.message === undefined ? {} : { message: candidate.message }),
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("accepts extra keys on installed-file inventories", async () => {
    const root = await mkdtemp(join(tmpdir(), "litellm-bench-installed-extra-"));
    const workspace = join(root, "workspace");
    const artifactsDirectory = join(root, "artifacts");
    await mkdir(workspace);
    const runner = {
      run: (command: CommandSpec) =>
        Effect.promise(async () => {
          const destinationIndex = command.arguments.indexOf("--dest");
          if (destinationIndex >= 0) {
            await writeFile(
              join(
                command.arguments[destinationIndex + 1] as string,
                "litellm-1.0-py3-none-any.whl",
              ),
              "wheel",
            );
          }
          const reportIndex = command.arguments.indexOf("--report");
          if (reportIndex >= 0) {
            await writeFile(
              command.arguments[reportIndex + 1] as string,
              JSON.stringify({
                install: [{
                  metadata: { name: "litellm", version: "1.0.0" },
                  download_info: { url: "file:///downloads/litellm-1.0-py3-none-any.whl" },
                }],
              }),
            );
          }
          const stdout = command.executable === "uv" && command.arguments.includes("--version")
            ? "uv 1.0\n"
            : command.executable === "uv" && command.arguments.includes("python")
                && command.arguments.includes("find")
            ? "/python\n"
            : command.arguments.includes("--version")
            ? "pip 1.0\n"
            : command.arguments.some((argument) => argument.includes("site.getsitepackages"))
            ? "[\"/target/site-packages\"]\n"
            : command.arguments.some((argument) => argument.includes("m.distributions"))
            ? "{\"paths\":[\"/target/site-packages/litellm.py\"],\"missing\":[],\"outside\":[],\"nonfiles\":[],\"extra\":true}\n"
            : command.arguments.some((argument) => argument.includes("importlib.metadata"))
            ? "1.0.0\n"
            : command.arguments.some((argument) => argument.includes("platform.python_version"))
            ? "{\"version\":\"3.12.0\",\"implementation\":\"CPython\"}\n"
            : "";
          return { stdout, stderr: "" };
        }),
    };
    try {
      const prepared = await runPlatform(prepareEnvironment(runner, {
        python: "3.12",
        requirement: "litellm==1.0",
        distribution: "litellm",
        expected_version: "1.0.0",
        resolver: { binary_only: true },
        workspace,
        artifacts_dir: artifactsDirectory,
      }));
      expect(prepared.installed_files).toEqual(["/target/site-packages/litellm.py"]);
      expect(prepared.python_metadata).toEqual({
        version: "3.12.0",
        implementation: "CPython",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a non-wheel anywhere in a binary-only closure", async () => {
    const root = await mkdtemp(join(tmpdir(), "litellm-bench-non-wheel-"));
    const workspace = join(root, "workspace");
    const artifactsDirectory = join(root, "artifacts");
    await mkdir(workspace);
    const runner = {
      run: (command: CommandSpec) =>
        Effect.promise(async () => {
          const destinationIndex = command.arguments.indexOf("--dest");
          if (destinationIndex >= 0) {
            await writeFile(
              join(command.arguments[destinationIndex + 1] as string, "dependency-1.0.tar.gz"),
              "sdist",
            );
          }
          const reportIndex = command.arguments.indexOf("--report");
          if (reportIndex >= 0) {
            await writeFile(
              command.arguments[reportIndex + 1] as string,
              JSON.stringify({
                install: [{
                  metadata: { name: "litellm", version: "1.0.0" },
                  download_info: { url: "file:///downloads/dependency-1.0.tar.gz" },
                }],
              }),
            );
          }
          const stdout = command.executable === "uv" && command.arguments.includes("--version")
            ? "uv 1.0\n"
            : command.executable === "uv" && command.arguments.includes("find")
            ? "/python\n"
            : command.arguments.includes("--version")
            ? "pip 1.0\n"
            : command.arguments.some((argument) => argument.includes("site.getsitepackages"))
            ? "[\"/target/site-packages\"]\n"
            : command.arguments.some((argument) => argument.includes("m.distributions"))
            ? "{\"paths\":[],\"missing\":[],\"outside\":[],\"nonfiles\":[]}\n"
            : command.arguments.some((argument) => argument.includes("importlib.metadata"))
            ? "1.0.0\n"
            : command.arguments.some((argument) => argument.includes("platform.python_version"))
            ? "{\"version\":\"3.12.0\"}\n"
            : "";
          return { stdout, stderr: "" };
        }),
    };
    try {
      await expect(runPlatform(prepareEnvironment(runner, {
        python: "3.12",
        requirement: "litellm==1.0.0",
        distribution: "litellm",
        expected_version: "1.0.0",
        resolver: { binary_only: true },
        workspace,
        artifacts_dir: artifactsDirectory,
      }))).rejects.toMatchObject({
        _tag: "PythonEnvironmentError",
        message: expect.stringContaining("non-wheel artifacts"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it(
    "includes console scripts and wheel .data files in the installed footprint inventory",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "litellm-bench-wheel-install-"));
      const wheelhouse = join(root, "wheelhouse");
      const workspace = join(root, "workspace");
      const artifactsDirectory = join(root, "artifacts");
      await Promise.all([mkdir(wheelhouse), mkdir(workspace)]);
      const wheel = join(wheelhouse, "demo_footprint-1.0.0-py3-none-any.whl");
      const buildWheel = [
        "import csv, io, sys, zipfile",
        "wheel=sys.argv[1]",
        "files={'demo_pkg/__init__.py':b'def main(): return 0\\n','demo_footprint-1.0.0.dist-info/METADATA':b'Metadata-Version: 2.1\\nName: demo-footprint\\nVersion: 1.0.0\\n','demo_footprint-1.0.0.dist-info/WHEEL':b'Wheel-Version: 1.0\\nGenerator: test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n','demo_footprint-1.0.0.dist-info/entry_points.txt':b'[console_scripts]\\ndemo-footprint=demo_pkg:main\\n','demo_footprint-1.0.0.data/data/share/demo-footprint/payload.txt':b'payload'}",
        "record=''.join(f'{path},,\\n' for path in [*files,'demo_footprint-1.0.0.dist-info/RECORD']).encode()",
        "files['demo_footprint-1.0.0.dist-info/RECORD']=record",
        "z=zipfile.ZipFile(wheel,'w',zipfile.ZIP_DEFLATED)",
        "[z.writestr(path,data) for path,data in files.items()]",
        "z.close()",
      ].join(";");
      await executeFile(process.env.PYTHON ?? "python3", ["-c", buildWheel, wheel]);
      const runner = {
        run: (command: CommandSpec) =>
          Effect.tryPromise({
            try: async () => {
              const result = await executeFile(command.executable, [...command.arguments], {
                cwd: command.cwd,
                env: command.environment,
                timeout: command.timeoutMs,
                encoding: "utf8",
              });
              return { stdout: result.stdout, stderr: result.stderr };
            },
            catch: (error) => error,
          }),
      };
      try {
        const prepared = await runPlatform(prepareEnvironment(runner, {
          python: process.env.PYTHON ?? "python3",
          requirement: "demo-footprint==1.0.0",
          distribution: "demo-footprint",
          expected_version: "1.0.0",
          resolver: { find_links: [wheelhouse], binary_only: true },
          workspace,
          artifacts_dir: artifactsDirectory,
          timeout_seconds: 60,
        }));
        expect(prepared.installed_files.some((path) => path.endsWith("/bin/demo-footprint"))).toBe(
          true,
        );
        expect(
          prepared.installed_files.some((path) =>
            path.endsWith("/share/demo-footprint/payload.txt")
          ),
        ).toBe(true);
        expect((await runPlatform(combinedSize(prepared.installed_files))).logical_bytes)
          .toBeGreaterThan(0);
        expect(prepared.artifacts).toEqual([expect.objectContaining({
          filename: "demo_footprint-1.0.0-py3-none-any.whl",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        })]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it("executes the timing asset as a CPython black box", async () => {
    const root = await mkdtemp(join(tmpdir(), "litellm-bench-timing-asset-"));
    const request = join(root, "request.json");
    const output = join(root, "output.json");
    await writeFile(
      request,
      JSON.stringify({
        python: process.env.PYTHON ?? "python3",
        statement: "import json",
        timeout_seconds: 10,
        samples: 2,
        output_path: output,
      }),
    );
    try {
      await executeFile(process.env.PYTHON ?? "python3", [
        fileURLToPath(timingSupervisorUrl),
        request,
      ]);
      const response = JSON.parse(await readFile(output, "utf8"));
      expect(response.status).toBe("ok");
      expect(response.samples_seconds).toHaveLength(2);
      expect(response.samples_seconds.every((value: number) => value > 0)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("executes the diagnostic asset inside CPython", async () => {
    const root = await mkdtemp(join(tmpdir(), "litellm-bench-probe-asset-"));
    const request = join(root, "request.json");
    const output = join(root, "output.json");
    await writeFile(
      request,
      JSON.stringify({
        workload: { name: "fractions", statement: "import fractions" },
        output_path: output,
        collect_import_time: true,
        collect_modules: true,
        collect_peak_rss: true,
        collect_network: false,
      }),
    );
    try {
      await executeFile(process.env.PYTHON ?? "python3", [fileURLToPath(pythonProbeUrl), request]);
      const response = JSON.parse(await readFile(output, "utf8"));
      expect(response.status).toBe("ok");
      expect(response.observation.import_only_seconds).toBeGreaterThan(0);
      expect(response.observation.new_module_count).toBeGreaterThan(0);
      expect(response.observation.peak_rss_bytes).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
