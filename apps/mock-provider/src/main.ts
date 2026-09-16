import { NodeRuntime, NodeServices } from "@effect/platform-node";
import type { MockStats } from "@litellm-bench/contracts";
import { Config, Effect, FileSystem, Ref } from "effect";
import cluster from "node:cluster";
import { readClusterStats, reportStats, supervise } from "./cluster.js";
import {
  createMockServer,
  decodePngExpectations,
  emptyStats,
  FixtureError,
  type MockServerOptions,
} from "./server.js";

const serve = Effect.gen(function*() {
  const path = yield* Config.String("MOCK_FIXTURE");
  const port = yield* Config.Int("MOCK_PORT").pipe(Config.withDefault(8080));
  const rawPngExpectations = yield* Config.String("MOCK_PNG_EXPECTATIONS").pipe(
    Config.withDefault("[]"),
  );
  if (port < 0 || port > 65535) {
    return yield* new FixtureError({ message: "invalid MOCK_PORT" });
  }
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(path);
  const fixture = yield* Effect.try({
    try: () => JSON.parse(contents) as unknown,
    catch: (cause) => new FixtureError({ message: `invalid JSON in ${path}`, cause }),
  });
  const pngExpectations = yield* Effect.try({
    try: () => decodePngExpectations(JSON.parse(rawPngExpectations) as unknown),
    catch: (cause) => new FixtureError({ message: "invalid MOCK_PNG_EXPECTATIONS", cause }),
  });
  const options: MockServerOptions = { port, pngExpectations };
  if (!cluster.isWorker) {
    yield* createMockServer(fixture, options);
    return yield* Effect.never;
  }
  const statistics = yield* Ref.make<MockStats>(emptyStats);
  yield* Effect.forkScoped(reportStats(statistics));
  yield* createMockServer(fixture, { ...options, statistics, readStats: readClusterStats });
  return yield* Effect.never;
});

/**
 * `MOCK_WORKERS` above 1 runs the server as a `node:cluster`: the primary only forks and supervises,
 * every worker accepts on the shared port, and `/__stats` reports the cluster-wide totals.
 */
const main = Effect.gen(function*() {
  const workers = yield* Config.Int("MOCK_WORKERS").pipe(Config.withDefault(1));
  if (workers < 1) {
    return yield* new FixtureError({ message: "invalid MOCK_WORKERS" });
  }
  if (workers > 1 && cluster.isPrimary) {
    return yield* supervise(workers);
  }
  return yield* serve;
});
NodeRuntime.runMain(Effect.scoped(main).pipe(Effect.provide(NodeServices.layer)));
