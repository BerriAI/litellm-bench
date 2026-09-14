import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Path } from "effect";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import type { DockerContainer, DockerContainerSpec, DockerEngineShape } from "./docker.js";
import { K6Error, type K6Shape } from "./k6.js";
import type { K6Measurement, ProxyExperiment } from "./models.js";
import { parseCgroupValue, runProxyExperiment, validateExperiment } from "./runtime.js";

const platform = await Effect.runPromise(
  Effect.all({ fs: FileSystem.FileSystem, path: Path.Path }).pipe(
    Effect.provide(NodeServices.layer),
  ),
);
const join = platform.path.join;
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
const writeFile = (location: string, contents: string) =>
  Effect.runPromise(platform.fs.writeFileString(location, contents));

const directories = new Set<string>();

const temporaryExperiment = async (): Promise<ProxyExperiment> => {
  const directory = await mkdtemp(join(tmpdir(), "litellm-bench-proxy-runtime-"));
  directories.add(directory);
  const inputs = join(directory, "inputs");
  await mkdir(inputs);
  const proxyConfigPath = join(inputs, "proxy.yaml");
  const fixturePath = join(inputs, "fixture.json");
  await writeFile(proxyConfigPath, "model_list: []\n");
  await writeFile(
    fixturePath,
    JSON.stringify({
      version: 2,
      operations: [{
        id: "chat",
        operation: "chat-completions",
        method: "POST",
        path: "/v1/chat/completions",
        expect: {},
        response: {
          kind: "json",
          timing: { response_delay_ms: 0 },
          body: {},
        },
      }],
    }),
  );
  return {
    image: "proxy:test",
    resources: { cpus: 1, memory: "1g", workers: 1, idleSeconds: 0, logDriver: "none" },
    artifactsDirectory: join(directory, "artifacts"),
    trials: [{
      id: "trial-1",
      scenario: "scenario",
      variant: "default",
      round: 1,
      load: { mode: "closed", concurrency: 1, duration_seconds: 1, warmup_seconds: 0 },
      workload: {
        body: new Uint8Array([123, 125]),
        request: { method: "POST", path: "/v1/chat/completions", headers: {} },
        response: { status: 200, jsonEquals: [] },
      },
      proxyConfigPath,
      fixturePath,
      mockImage: "node:test",
      dimensions: {},
    }],
  };
};

const commandOutput = (stdout = "") => Effect.succeed({ exitCode: 0, stdout, stderr: "" });
const successfulMeasurement = (artifactsDirectory: string): K6Measurement => ({
  engine: "k6",
  exitCode: 0,
  artifacts: {
    result: `${artifactsDirectory}/result`,
    log: `${artifactsDirectory}/log`,
    summary: `${artifactsDirectory}/summary`,
    configuration: `${artifactsDirectory}/config`,
    payload: `${artifactsDirectory}/payload`,
  },
  result: {
    started: 1,
    completed: 1,
    successful: 1,
    failed: 0,
    dropped: 0,
    interrupted: 0,
    window_completed: 1,
    window_successful: 1,
    window_failed: 0,
    tail_completed: 0,
    tail_successful: 0,
    tail_failed: 0,
    warmup_requests: 0,
    warmup_failed: 0,
    measurement_seconds: 1,
    drain_seconds: 0,
    elapsed_seconds: 1,
    completion_rps: 1,
    error_rate: 0,
    latency: {
      samples: 1,
      mean_ms: 1,
      p50_ms: 1,
      p95_ms: 1,
      p99_ms: 1,
      max_ms: 1,
    },
    errors: {},
  },
});
const runLive = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

const fakeDocker = (
  events: string[],
  stats: Record<string, unknown> = { requests: 1, failures: 0, errors: {} },
): DockerEngineShape => ({
  verify: Effect.succeed({
    version: "27.1",
    os: "linux",
    architecture: "x86_64",
    cgroupVersion: "2",
  }),
  inspectImage: () => Effect.succeed("sha256:image"),
  network: (name) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        events.push(`start network ${name}`);
        return name;
      }),
      () => Effect.sync(() => events.push(`remove network ${name}`)),
    ),
  container: (spec: DockerContainerSpec) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        events.push(`start container ${spec.name}`);
        const container: DockerContainer = {
          name: spec.name,
          exec: (args) => {
            if (args[0] === "sh" && args[2]?.includes("memory.peak")) {
              events.push(`reset peak ${spec.name}`);
              return commandOutput();
            }
            if (
              spec.name.endsWith("-mock") && args[0] === "node" && args[1] === "-e"
              && args[2]?.includes("__stats")
            ) {
              return commandOutput(`${JSON.stringify(stats)}\n`);
            }
            if (args[0] === "cat" && args[1]?.endsWith("memory.stat")) {
              return commandOutput("anon 20\nfile 10\n");
            }
            if (args[0] === "cat" && args[1]?.endsWith("cpu.stat")) {
              return commandOutput(
                "usage_usec 10\nnr_periods 1\nnr_throttled 0\nthrottled_usec 0\n",
              );
            }
            if (args[0] === "cat" && args[1]?.endsWith("cpu.max")) {
              return commandOutput("100000 100000\n");
            }
            if (args[0] === "cat" && args[1]?.endsWith("cpuset.cpus.effective")) {
              return commandOutput("0\n");
            }
            if (args[0] === "cat") return commandOutput("20\n");
            return commandOutput();
          },
        };
        return container;
      }),
      () => Effect.sync(() => events.push(`remove container ${spec.name}`)),
    ),
});

afterEach(async () => {
  await Promise.all([...directories].map((path) => rm(path, { recursive: true, force: true })));
  directories.clear();
});

describe("proxy runtime", () => {
  it("rejects duplicate and unsafe trial IDs before infrastructure setup", async () => {
    const experiment = await temporaryExperiment();
    for (
      const trials of [
        [experiment.trials[0]!, experiment.trials[0]!],
        [{ ...experiment.trials[0]!, id: "../escape" }],
      ]
    ) {
      const error = await Effect.runPromise(
        validateExperiment({ ...experiment, trials }).pipe(Effect.flip),
      );
      expect(error.message).toMatch(/duplicate|simple directory/);
    }
  });

  it("parses cgroup scalar and keyed values strictly", async () => {
    await expect(Effect.runPromise(parseCgroupValue("42\n", "memory.current"))).resolves.toBe(42);
    await expect(Effect.runPromise(parseCgroupValue("anon 21\nfile 8\n", "memory.stat", "anon")))
      .resolves.toBe(21);
    await expect(Effect.runPromise(
      parseCgroupValue("max\n", "memory.current").pipe(Effect.flip),
    )).resolves.toMatchObject({ operation: "read cgroup" });
  });

  it("verifies k6 before creating Docker resources", async () => {
    const experiment = await temporaryExperiment();
    const events: string[] = [];
    const k6: K6Shape = {
      verify: Effect.fail(new K6Error({ message: "wrong k6" })),
      run: () => Effect.die("must not run"),
    };
    const error = await runLive(
      runProxyExperiment(fakeDocker(events), k6, experiment).pipe(Effect.flip),
    );
    expect(error.operation).toBe("verify k6");
    expect(events).toEqual([]);
  });

  it("fails fast with mock diagnostics before timed trials", async () => {
    const base = await temporaryExperiment();
    const experiment = base;
    const events: string[] = [];
    let runs = 0;
    const k6: K6Shape = {
      verify: Effect.succeed("k6 v2.2.0 (test)"),
      run: (request) =>
        Effect.sync(() => {
          runs += 1;
          return {
            engine: "k6",
            exitCode: 0,
            artifacts: {
              result: `${request.artifactsDirectory}/result`,
              log: `${request.artifactsDirectory}/log`,
              summary: `${request.artifactsDirectory}/summary`,
              configuration: `${request.artifactsDirectory}/config`,
              payload: `${request.artifactsDirectory}/payload`,
            },
            result: {
              started: 1,
              completed: 1,
              successful: 0,
              failed: 1,
              dropped: 0,
              interrupted: 0,
              window_completed: 1,
              window_successful: 0,
              window_failed: 1,
              tail_completed: 0,
              tail_successful: 0,
              tail_failed: 0,
              warmup_requests: 0,
              warmup_failed: 0,
              measurement_seconds: 1,
              drain_seconds: 0,
              elapsed_seconds: 1,
              completion_rps: 0,
              error_rate: 1,
              errors: { http: 1 },
            },
          };
        }),
    };
    const error = await runLive(
      runProxyExperiment(
        fakeDocker(events, {
          requests: 1,
          failures: 1,
          errors: { request_body: 1 },
          last_mismatch: {
            reason: "request_body",
            method: "POST",
            path: "/v1/chat/completions",
            operation_id: "chat",
            detail: "missing fields: stream",
          },
        }),
        k6,
        experiment,
        {
          networkName: () => "bench-preflight",
          readinessRequest: async () => ({ ok: true, status: 200 }),
          mockServerPath: "/mock/main.js",
        },
      ).pipe(Effect.flip),
    );

    expect(runs).toBe(1);
    expect(error.operation).toBe("preflight trial-1");
    expect(error.message).toContain("missing fields: stream");
    expect(events.some((event) => event.includes("bench-preflight-0-mock"))).toBe(false);
    expect(events.some((event) => event.includes("bench-preflight-preflight-0-mock"))).toBe(true);
  });

  it("preflights each distinct contract once before timed trials", async () => {
    const base = await temporaryExperiment();
    const first = base.trials[0]!;
    const experiment: ProxyExperiment = {
      ...base,
      trials: [first, { ...first, id: "trial-2", round: 2 }],
    };
    const events: string[] = [];
    let runs = 0;
    const k6: K6Shape = {
      verify: Effect.succeed("k6 v2.2.0 (test)"),
      run: (request) =>
        Effect.sync(() => {
          runs += 1;
          return {
            engine: "k6",
            exitCode: 0,
            artifacts: {
              result: `${request.artifactsDirectory}/result`,
              log: `${request.artifactsDirectory}/log`,
              summary: `${request.artifactsDirectory}/summary`,
              configuration: `${request.artifactsDirectory}/config`,
              payload: `${request.artifactsDirectory}/payload`,
            },
            result: {
              started: 1,
              completed: 1,
              successful: 1,
              failed: 0,
              dropped: 0,
              interrupted: 0,
              window_completed: 1,
              window_successful: 1,
              window_failed: 0,
              tail_completed: 0,
              tail_successful: 0,
              tail_failed: 0,
              warmup_requests: 0,
              warmup_failed: 0,
              measurement_seconds: 1,
              drain_seconds: 0,
              elapsed_seconds: 1,
              completion_rps: 1,
              error_rate: 0,
              latency: {
                samples: 1,
                mean_ms: 1,
                p50_ms: 1,
                p95_ms: 1,
                p99_ms: 1,
                max_ms: 1,
              },
              errors: {},
            },
          };
        }),
    };

    const raw = await runLive(runProxyExperiment(
      fakeDocker(events, { requests: 1, failures: 0, errors: {} }),
      k6,
      experiment,
      {
        networkName: () => "bench-preflight-ok",
        readinessRequest: async () => ({ ok: true, status: 200 }),
        mockServerPath: "/mock/main.js",
      },
    ));

    expect(runs).toBe(3);
    expect(raw.trials).toHaveLength(2);
    expect(events.filter((event) => event.includes("ok-preflight-0-mock")))
      .toHaveLength(2);
  });

  it("releases proxy, mock, and network when the load generator fails", async () => {
    const experiment = await temporaryExperiment();
    const events: string[] = [];
    let verifications = 0;
    let runs = 0;
    const k6: K6Shape = {
      verify: Effect.sync(() => {
        verifications += 1;
        return "k6 v2.2.0 (test)";
      }),
      run: (request) =>
        Effect.suspend(() => {
          runs += 1;
          return runs === 1
            ? Effect.succeed(successfulMeasurement(request.artifactsDirectory))
            : Effect.fail(new K6Error({ message: "load failed" }));
        }),
    };
    const raw = await runLive(runProxyExperiment(
      fakeDocker(events),
      k6,
      experiment,
      {
        networkName: () => "bench-network",
        readinessRequest: async () => ({ ok: true, status: 200 }),
        mockServerPath: "/mock/main.js",
      },
    ));

    expect(verifications).toBe(1);
    expect(runs).toBe(2);
    expect(raw.trials[0]?.error).toContain("load failed");
    expect(events).toEqual([
      "start network bench-network",
      "start container bench-network-preflight-0-mock",
      "start container bench-network-preflight-0-proxy",
      "remove container bench-network-preflight-0-proxy",
      "remove container bench-network-preflight-0-mock",
      "start container bench-network-0-mock",
      "start container bench-network-0-proxy",
      "remove container bench-network-0-proxy",
      "remove container bench-network-0-mock",
      "remove network bench-network",
    ]);
    const retained = JSON.parse(
      (await readFile(join(experiment.artifactsDirectory, "trials.jsonl"), "utf8")).trim(),
    );
    expect(retained.error).toContain("load failed");
  });

  it("runs warmup separately and brackets telemetry after resetting peak memory", async () => {
    const base = await temporaryExperiment();
    const experiment: ProxyExperiment = {
      ...base,
      trials: [{
        ...base.trials[0]!,
        isolateMeasurementWindow: true,
        load: { mode: "closed", concurrency: 1, duration_seconds: 1, warmup_seconds: 1 },
      }],
    };
    const events: string[] = [];
    let runs = 0;
    const k6: K6Shape = {
      verify: Effect.succeed("k6 v2.2.0 (test)"),
      run: (request) =>
        Effect.sync(() => {
          runs += 1;
          return {
            engine: "k6",
            exitCode: 0,
            artifacts: {
              result: `${request.artifactsDirectory}/result`,
              log: `${request.artifactsDirectory}/log`,
              summary: `${request.artifactsDirectory}/summary`,
              configuration: `${request.artifactsDirectory}/config`,
              payload: `${request.artifactsDirectory}/payload`,
            },
            result: {
              started: 1,
              completed: 1,
              successful: 1,
              failed: 0,
              dropped: 0,
              interrupted: 0,
              window_completed: 1,
              window_successful: 1,
              window_failed: 0,
              tail_completed: 0,
              tail_successful: 0,
              tail_failed: 0,
              warmup_requests: 0,
              warmup_failed: 0,
              measurement_seconds: 1,
              drain_seconds: 0,
              elapsed_seconds: 1,
              completion_rps: 1,
              error_rate: 0,
              latency: {
                samples: 1,
                mean_ms: 1,
                p50_ms: 1,
                p95_ms: 1,
                p99_ms: 1,
                max_ms: 1,
              },
              errors: {},
            },
          };
        }),
    };
    const raw = await runLive(runProxyExperiment(fakeDocker(events), k6, experiment, {
      networkName: () => "bench-window",
      readinessRequest: async () => ({ ok: true, status: 200 }),
      mockServerPath: "/mock/main.js",
    }));
    expect(runs).toBe(3);
    expect(events.filter((event) => event.startsWith("reset peak"))).toHaveLength(2);
    expect(raw.trials[0]?.client?.result?.warmup_requests).toBe(1);
    expect(raw.trials[0]?.telemetry?.window).toBe("post-warmup measurement process and drain");
  });

  it("accepts version 2 fixtures through the shared preflight decoder", async () => {
    const experiment = await temporaryExperiment();
    await writeFile(
      experiment.trials[0]!.fixturePath,
      JSON.stringify({
        version: 2,
        operations: [{
          id: "stream",
          operation: "generic",
          method: "POST",
          path: "/events",
          expect: {},
          response: {
            kind: "sse",
            timing: { first_event_delay_ms: 0, event_interval_ms: 0 },
            events: [{ data: "[DONE]" }],
          },
        }],
      }),
    );
    const events: string[] = [];
    let runs = 0;
    const raw = await runLive(runProxyExperiment(
      fakeDocker(events),
      {
        verify: Effect.succeed("k6 v2.2.0 (test)"),
        run: (request) =>
          Effect.suspend(() => {
            runs += 1;
            return runs === 1
              ? Effect.succeed(successfulMeasurement(request.artifactsDirectory))
              : Effect.fail(new K6Error({ message: "reached load generator" }));
          }),
      },
      experiment,
      {
        networkName: () => "bench-v2",
        readinessRequest: async () => ({ ok: true, status: 200 }),
      },
    ));
    expect(raw.trials[0]?.error).toContain("reached load generator");
    expect(events).toContain("start container bench-v2-0-mock");
  });

  it("bounds each proxy readiness request", async () => {
    const experiment = await temporaryExperiment();
    const events: string[] = [];
    const k6: K6Shape = {
      verify: Effect.succeed("k6 v2.2.0 (test)"),
      run: () => Effect.die("must not run"),
    };
    const started = performance.now();
    const error = await runLive(
      runProxyExperiment(
        fakeDocker(events),
        k6,
        experiment,
        {
          networkName: () => "bench-network",
          proxyReadinessAttempts: 1,
          readinessRequestTimeoutMs: 5,
          readinessRequest: (_url, signal) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
        },
      ).pipe(Effect.flip),
    );

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(error).toMatchObject({
      operation: "wait for proxy",
      message: expect.stringMatching(/timeout|aborted/i),
    });
    expect(events.at(-1)).toBe("remove network bench-network");
  });

  it("rejects invalid fixtures before starting a container", async () => {
    const experiment = await temporaryExperiment();
    await writeFile(experiment.trials[0]!.fixturePath, "{\"method\":\"POST\"}");
    const events: string[] = [];
    const k6: K6Shape = {
      verify: Effect.succeed("k6 v2.2.0 (test)"),
      run: () => Effect.die("must not run"),
    };
    const error = await runLive(
      runProxyExperiment(
        fakeDocker(events),
        k6,
        experiment,
        { networkName: () => "bench-network" },
      ).pipe(Effect.flip),
    );
    expect(error.message).toMatch(/Missing key[\s\S]*path|Expected no excess property/);
    expect(events).toEqual([
      "start network bench-network",
      "remove network bench-network",
    ]);
  });
});
