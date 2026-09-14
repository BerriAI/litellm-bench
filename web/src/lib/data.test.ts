import assert from "node:assert/strict";
import test from "node:test";

import { type Fetcher, loadAnnotations, loadIndex } from "./data.ts";

const validIndex = {
  generated_at: "2026-09-13T20:45:07Z",
  record_count: 1,
  benchmarks: [{ id: "sdk-import-time", label: "Python import time", kind: "sdk" }],
  records: [{
    record_id: "a".repeat(64),
    comparison_id: "b".repeat(64),
    case_id: "c".repeat(64),
    benchmark_id: "sdk-import-time",
    benchmark_label: "Python import time",
    kind: "sdk",
    status: "ok",
    path: "results/record.json",
    metrics: [{
      id: "import.median",
      label: "Median fresh import",
      value: 42,
      unit: "ms",
      better: "lower",
    }],
    created_at: "2026-09-13T20:45:07Z",
    job: "base",
    canonical: true,
    version: "1.2.3",
    platform: "linux",
    architecture: "x86_64",
    source: {},
  }],
};

function response(status: number, value: unknown): Fetcher {
  return async () => ({ status, ok: status >= 200 && status < 300, json: async () => value });
}

test("loads a strictly decoded benchmark index", async () => {
  const index = await loadIndex("/bench/", response(200, validIndex));
  assert.equal(index.records[0]?.metrics[0]?.value, 42);
});

test("rejects malformed, inconsistent, and excess index fields", async () => {
  await assert.rejects(loadIndex("", response(200, { ...validIndex, unexpected: true })), {
    message: /Invalid benchmark index/,
  });
  await assert.rejects(loadIndex("", response(200, { ...validIndex, record_count: 2 })), {
    message: /record_count/,
  });
  await assert.rejects(loadIndex("", response(503, validIndex)), {
    message: /Unable to load result index: 503/,
  });
});

test("treats missing optional annotations as empty and rejects malformed documents", async () => {
  assert.deepEqual(await loadAnnotations("", response(404, null)), []);
  assert.deepEqual(await loadAnnotations("", response(200, { annotations: [] })), []);
  await assert.rejects(loadAnnotations("", response(200, [])), {
    message: /Invalid benchmark annotations/,
  });
});
