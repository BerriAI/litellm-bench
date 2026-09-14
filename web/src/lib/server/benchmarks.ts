import { benchmarkCatalog } from "@litellm-bench/catalog";
import { deriveIndex } from "@litellm-bench/result-store";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseAnnotations } from "../annotationContract.ts";
import type { BenchmarkIndex } from "../data.ts";

export function dataDirectory(): string {
  return resolve(process.env.BENCHMARK_DATA_DIR ?? "../data");
}

export function readIndex(directory = dataDirectory()) {
  return deriveIndex(directory);
}

export async function readAnnotations(directory = dataDirectory()) {
  let content: string;
  try {
    content = await readFile(resolve(directory, "annotations.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return parseAnnotations(JSON.parse(content));
}

export function benchmarkDirectory(index: BenchmarkIndex) {
  const current = Object.entries(benchmarkCatalog).map(([id, definition]) => ({
    id,
    label: definition.label,
    kind: definition.kind,
  }));
  return [...current, ...index.benchmarks.filter(({ id }) => !Object.hasOwn(benchmarkCatalog, id))];
}

export async function staticBenchmarks(directory = dataDirectory()) {
  return benchmarkDirectory(await readIndex(directory));
}

export async function benchmarkData(id: string, directory = dataDirectory()) {
  const [index, annotations] = await Promise.all([
    readIndex(directory),
    readAnnotations(directory),
  ]);
  const benchmark = benchmarkDirectory(index).find((benchmark) => benchmark.id === id);
  if (!benchmark) return undefined;
  return {
    benchmark,
    records: index.records.filter((record) => record.benchmark_id === id),
    annotations: annotations.filter((annotation) => annotation.benchmark_id === id),
  };
}
