import { resolveVersion } from "@litellm-bench/versions";
import { Effect } from "effect";
import assert from "node:assert/strict";
import test from "node:test";
import { buildBenchmarkMatrix, makeRunSpec, type SuiteBenchmark } from "./index.js";

const benchmark: SuiteBenchmark = {
  id: "sdk-import-time",
  label: "Python import time",
  kind: "sdk",
  artifact: "sdk",
  definition: {
    id: "sdk-import-time",
    label: "Python import time",
    kind: "sdk",
    artifact: "sdk",
    output_metrics: [{ id: "import.median", unit: "ms", better: "lower" }],
    protocol: {
      question: "How long does import take?",
      scenarios: [{ id: "root-import", label: "import litellm", dimensions: {} }],
      measurements: [{
        id: "import_duration_ms",
        label: "Import",
        unit: "ms",
        role: "primary",
      }],
      analyses: [],
    },
    jobs: [{
      id: "base",
      canonical: true,
      runner: "ubuntu-24.04",
      config: { python: "3.12" },
    }],
  },
};

test("plans one job per version and benchmark job", async () => {
  const matrix = await Effect.runPromise(
    buildBenchmarkMatrix([benchmark], "1.80.0,1.81.0", "all"),
  );

  assert.deepEqual(matrix.versions, ["1.80.0", "1.81.0"]);
  assert.deepEqual(matrix.include, [
    {
      version: "1.80.0",
      job_id: "sdk-import-time-1-80-0-base",
      benchmark_id: "sdk-import-time",
      benchmark_job: "base",
      runner: "ubuntu-24.04",
      needs_proxy: false,
    },
    {
      version: "1.81.0",
      job_id: "sdk-import-time-1-81-0-base",
      benchmark_id: "sdk-import-time",
      benchmark_job: "base",
      runner: "ubuntu-24.04",
      needs_proxy: false,
    },
  ]);
});

test("creates an identified run spec", async () => {
  const resolution = resolveVersion("1.80.0");
  assert.equal(resolution._tag, "Resolved");
  if (resolution._tag !== "Resolved") return;

  const spec = await Effect.runPromise(makeRunSpec(benchmark, "base", resolution.release));
  assert.match(spec.case_id, /^[a-f0-9]{64}$/);
  assert.match(spec.comparison_id, /^[a-f0-9]{64}$/);
  assert.deepEqual(spec.artifact, {
    requirement: "litellm==1.80.0",
    distribution: "litellm",
  });
});

test("rejects unknown benchmark selections", async () => {
  const result = await Effect.runPromiseExit(
    buildBenchmarkMatrix([benchmark], "1.80.0", "missing"),
  );
  assert.equal(result._tag, "Failure");
  assert.match(String(result), /unknown benchmark ids: missing/);
});
