import { fileURLToPath } from "node:url";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Path } from "effect";

import { generateCatalog, renderCatalog } from "./generate.js";

const check = process.argv.includes("--check");

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const repositoryDirectory = path.join(packageDirectory, "..", "..");
  const benchmarksDirectory = path.join(repositoryDirectory, "benchmarks");
  const outputPath = path.join(packageDirectory, "src", "generated.ts");
  if (!check) return yield* generateCatalog(benchmarksDirectory, outputPath);
  const expected = yield* renderCatalog(benchmarksDirectory);
  const actual = yield* fs.readFileString(outputPath);
  if (actual !== expected) {
    return yield* Effect.fail(new Error(`stale generated catalog: ${outputPath}`));
  }
}).pipe(Effect.provide(NodeServices.layer));

NodeRuntime.runMain(program);
