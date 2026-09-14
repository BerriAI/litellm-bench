import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  benchmarkData,
  benchmarkDirectory,
  readAnnotations,
  readIndex,
} from "./server/benchmarks.ts";

const fixtures = fileURLToPath(new URL("../../tests/fixtures/data", import.meta.url));

test("route data includes only the requested benchmark and annotations", async () => {
  const data = await benchmarkData("sdk-import-time", fixtures);
  assert.ok(data);
  assert.equal(data.records.length, 3);
  assert.ok(data.records.every((record) => record.benchmark_id === "sdk-import-time"));
  assert.equal(data.annotations.length, 1);
  const footprint = await benchmarkData("sdk-import-footprint", fixtures);
  assert.equal(footprint?.records.length, 1);
  assert.deepEqual(footprint?.annotations, []);
  assert.equal(await benchmarkData("unknown", fixtures), undefined);
});

test("directory preserves empty catalog entries and historical benchmarks", async () => {
  const index = await readIndex(fixtures);
  const directory = benchmarkDirectory({
    ...index,
    benchmarks: [...index.benchmarks, {
      id: "historical",
      label: "Historical benchmark",
      kind: "sdk",
    }],
  });
  assert.equal(directory.filter(({ id }) => id === "sdk-import-time").length, 1);
  assert.ok(directory.some(({ id }) => id === "historical"));
  const empty = await benchmarkData("proxy-ocr", fixtures);
  assert.ok(empty);
  assert.deepEqual(empty.records, []);
});

test("annotations are optional, but invalid documents fail explicitly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "benchmark-annotations-"));
  try {
    assert.deepEqual(await readAnnotations(directory), []);
    await writeFile(join(directory, "annotations.json"), "{}");
    await assert.rejects(readAnnotations(directory), /Invalid benchmark annotations/);
    await writeFile(join(directory, "annotations.json"), "{");
    await assert.rejects(readAnnotations(directory), SyntaxError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
