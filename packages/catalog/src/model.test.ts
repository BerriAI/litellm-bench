import { expect, it } from "@effect/vitest";

import type { BenchmarkDefinition } from "@litellm-bench/contracts/metadata";

import { buildCatalog } from "./model.js";

const definition = {
  id: "sample",
  label: "Sample",
  kind: "sdk",
  artifact: "sdk",
  output_metrics: [{ id: "latency", unit: "ms", better: "lower" }],
  protocol: { question: "How fast?", scenarios: [], measurements: [], analyses: [] },
  jobs: [{ id: "base", canonical: true, runner: "ubuntu-24.04", config: {} }],
} as const satisfies BenchmarkDefinition;

it("builds browser-safe lookup fields while retaining validated planning metadata", () => {
  const result = buildCatalog([{ directory: "sample", definition }]);
  expect(result._tag).toBe("Catalog");
  if (result._tag === "Catalog") {
    expect(result.value.sample?.metrics).toEqual({ latency: { unit: "ms", better: "lower" } });
    expect(result.value.sample?.canonicalJob).toBe("base");
    expect(result.value.sample?.definition.protocol.question).toBe("How fast?");
  }
});

it("rejects mismatched directories, duplicate ids, and ambiguous canonical jobs", () => {
  const result = buildCatalog([
    { directory: "wrong", definition },
    {
      directory: "sample",
      definition: {
        ...definition,
        jobs: [
          ...definition.jobs,
          { id: "alternate", canonical: true, runner: "ubuntu-24.04", config: {} },
        ],
      },
    },
  ]);
  expect(result._tag).toBe("InvalidCatalog");
  if (result._tag === "InvalidCatalog") {
    expect(result.issues.map((issue) => issue.message)).toEqual([
      "benchmark id \"sample\" must match directory name",
      "benchmark must declare exactly one canonical job",
      "duplicate benchmark id: sample",
    ]);
  }
});
