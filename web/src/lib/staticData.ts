import { NodePath } from "@effect/platform-node";
import { Effect, Path } from "effect";

import { benchmarkCatalog } from "@litellm-bench/catalog";
import type { BenchmarkIndex } from "@litellm-bench/contracts/results";
import { deriveIndex } from "@litellm-bench/result-store";

export type StaticBenchmark = BenchmarkIndex["benchmarks"][number];

export async function staticBenchmarks(): Promise<StaticBenchmark[]> {
  const path = Effect.runSync(Path.Path.pipe(Effect.provide(NodePath.layer)));
  const dataDirectory = process.env.BENCHMARK_DATA_DIR ?? path.resolve(process.cwd(), "../data");
  const index = await deriveIndex(dataDirectory);
  const current = Object.entries(benchmarkCatalog).map(([id, definition]) => ({
    id,
    label: definition.label,
    kind: definition.kind,
  }));
  return [
    ...current,
    ...index.benchmarks.filter((benchmark) => !(benchmark.id in benchmarkCatalog)),
  ];
}
