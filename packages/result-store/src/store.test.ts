import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Path } from "effect";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  BenchmarkResult,
  caseId,
  comparisonId,
  decodeStrict,
  type JsonRecord,
  RunSpec,
} from "@litellm-bench/contracts";

import { deriveIndex, ingest, recover } from "./store.js";

const platform = await Effect.runPromise(
  Effect.all({ fs: FileSystem.FileSystem, path: Path.Path }).pipe(
    Effect.provide(NodeServices.layer),
  ),
);
const join = platform.path.join;
const mkdir = (location: string, options?: { recursive?: boolean }) =>
  Effect.runPromise(platform.fs.makeDirectory(location, options));
const mkdtemp = (prefix: string) =>
  Effect.runPromise(platform.fs.makeTempDirectory({
    directory: platform.path.dirname(prefix),
    prefix: platform.path.basename(prefix),
  }));
const readdir = (location: string) => Effect.runPromise(platform.fs.readDirectory(location));
const readFile = (location: string, _encoding: "utf8") =>
  Effect.runPromise(platform.fs.readFileString(location));
const stat = async (location: string) => {
  try {
    return await Effect.runPromise(platform.fs.stat(location));
  } catch (cause) {
    const tag = typeof cause === "object" && cause !== null && "reason" in cause
        && typeof cause.reason === "object" && cause.reason !== null && "_tag" in cause.reason
      ? cause.reason._tag
      : undefined;
    throw Object.assign(new Error(String(cause)), { code: tag === "NotFound" ? "ENOENT" : tag });
  }
};
const writeFile = (location: string, contents: string, _encoding?: "utf8") =>
  Effect.runPromise(platform.fs.writeFileString(location, contents));

const fixture = (
  runId: string,
  value = 10,
  jobId = "base",
): readonly [typeof RunSpec.Type, typeof BenchmarkResult.Type] => {
  const zero = "0".repeat(64);
  const benchmark = {
    id: "demo",
    label: "Demo",
    kind: "sdk",
    output_metrics: [{ id: "time", unit: "ms", better: "lower" }],
    protocol: {
      question: "How fast?",
      scenarios: [{ id: "root", label: "Root", dimensions: {} }],
      measurements: [{
        id: "duration",
        label: "Duration",
        unit: "ms",
        role: "primary",
        better: "lower",
      }],
      analyses: [{ id: "median", label: "Median", measurement: "duration", aggregation: "median" }],
    },
  };
  const provisional = decodeStrict(RunSpec)({
    case_id: zero,
    comparison_id: zero,
    benchmark,
    job: { id: jobId, canonical: true, runner: "ubuntu", config: { samples: 1 } },
    version: { version: "1.0.0", artifacts: { sdk: { requirement: "litellm==1.0.0" } } },
    artifact: { requirement: "litellm==1.0.0" },
  });
  const spec = decodeStrict(RunSpec)({
    ...provisional,
    case_id: caseId(provisional),
    comparison_id: comparisonId(provisional),
  });
  const result = decodeStrict(BenchmarkResult)({
    run_id: runId,
    created_at: "2026-09-13T00:00:00Z",
    case_id: spec.case_id,
    comparison_id: spec.comparison_id,
    benchmark,
    job: spec.job,
    version: "1.0.0",
    artifact: spec.artifact,
    apparatus: { harness: "typescript" },
    status: "ok",
    metrics: [{ id: "time", label: "Time", value, unit: "ms", better: "lower" }],
    trials: [],
    analyses: [],
  });
  return [spec, result];
};

const writePair = async (root: string, name: string, runId: string, value = 10): Promise<void> => {
  const [spec, result] = fixture(runId, value);
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "benchmark-spec.json"), JSON.stringify(spec), "utf8");
  await writeFile(join(directory, "benchmark-result.json"), JSON.stringify(result), "utf8");
};

const writeFailedPair = async (
  root: string,
  name: string,
  runId: string,
  jobId = "base",
): Promise<void> => {
  const [spec, successful] = fixture(runId, 10, jobId);
  const result = decodeStrict(BenchmarkResult)({
    ...successful,
    status: "failed",
    metrics: [],
    error: { code: "process_failed", message: "benchmark failed" },
  });
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "benchmark-spec.json"), JSON.stringify(spec), "utf8");
  await writeFile(join(directory, "benchmark-result.json"), JSON.stringify(result), "utf8");
};

const temporary = (): Promise<string> => mkdtemp(join(tmpdir(), "litellm-result-store-"));
const source: JsonRecord = { provider: "test" };

test("append is idempotent and conflicting content does not mutate the store", async () => {
  const root = await temporary();
  const input = join(root, "input");
  const data = join(root, "data");
  await writePair(input, "one", "run-1");
  assert.equal(
    await ingest(input, data, source, "append", { now: () => "2026-09-13T01:00:00Z" }),
    1,
  );
  assert.equal(
    await ingest(input, data, source, "append", { now: () => "2026-09-13T02:00:00Z" }),
    0,
  );
  const recordPath = join(data, "results", "1.0.0", "demo", "run-1.json");
  const before = await readFile(recordPath, "utf8");
  await writePair(input, "one", "run-1", 11);
  await assert.rejects(ingest(input, data, source), /conflicting record/);
  assert.equal(await readFile(recordPath, "utf8"), before);
});

test("an invalid incoming batch performs no store writes", async () => {
  const root = await temporary();
  const input = join(root, "input");
  const data = join(root, "data");
  await writePair(input, "valid", "run-valid");
  await writePair(input, "invalid", "run-invalid");
  const invalidPath = join(input, "invalid", "benchmark-result.json");
  const invalid = JSON.parse(await readFile(invalidPath, "utf8")) as JsonRecord;
  await writeFile(invalidPath, JSON.stringify({ ...invalid, unexpected: true }), "utf8");
  await assert.rejects(ingest(input, data, source));
  await assert.rejects(stat(data), { code: "ENOENT" });
});

test("replacement removes every matching case and version including prior runs", async () => {
  const root = await temporary();
  const data = join(root, "data");
  const first = join(root, "first");
  const second = join(root, "second");
  await writePair(first, "a", "run-a");
  await writePair(first, "b", "run-b");
  await ingest(first, data, source, "append", { now: () => "2026-09-13T01:00:00Z" });
  await writePair(second, "c", "run-c");
  assert.equal(
    await ingest(second, data, source, "replace-case-version", {
      now: () => "2026-09-13T02:00:00Z",
    }),
    1,
  );
  assert.deepEqual((await readdir(join(data, "results", "1.0.0", "demo"))).sort(), ["run-c.json"]);
  const index = await deriveIndex(data, { now: () => "2026-09-13T03:00:00Z" });
  assert.equal(index.record_count, 1);
  assert.equal(index.records[0]?.canonical, true);
});

test("benchmark replacement removes prior data and stores the failed result as evidence", async () => {
  const root = await temporary();
  const data = join(root, "data");
  const first = join(root, "first");
  const failed = join(root, "failed");
  await writePair(first, "success", "run-success");
  await ingest(first, data, source, "replace-benchmark-version");
  await writeFailedPair(failed, "failure", "run-failure", "alternate");

  assert.equal(await ingest(failed, data, source, "replace-benchmark-version"), 1);
  assert.deepEqual(await readdir(join(data, "results", "1.0.0", "demo")), ["run-failure.json"]);
  const index = await deriveIndex(data);
  assert.equal(index.record_count, 1);
  assert.equal(index.records[0]?.status, "failed");
  assert.deepEqual(index.records[0]?.metrics, []);
  assert.deepEqual(index.records[0]?.failure, {
    code: "process_failed",
    message: "benchmark failed",
  });
});

test("recovery decodes journals and rejects malformed or excess-property documents", async () => {
  const root = await temporary();
  const data = join(root, "data");
  const committed = join(data, ".result-store", "transactions", "tx-committed");
  await mkdir(committed, { recursive: true });
  await writeFile(
    join(committed, "journal.json"),
    JSON.stringify({ version: 1, phase: "committed", applied: 0, operations: [] }),
    "utf8",
  );
  await recover(data);
  await assert.rejects(stat(committed), { code: "ENOENT" });

  for (
    const document of [
      "{",
      JSON.stringify({ version: 2, phase: "committed", applied: 0, operations: [] }),
      JSON.stringify({
        version: 1,
        phase: "committed",
        applied: 0,
        operations: [],
        extra: true,
      }),
      JSON.stringify({
        version: 1,
        phase: "unknown",
        applied: 0,
        operations: [],
      }),
      JSON.stringify({
        version: 1,
        phase: "applying",
        applied: 0,
        operations: [{ kind: "rename", destination: "results/x.json" }],
      }),
    ]
  ) {
    const transaction = join(data, ".result-store", "transactions", "tx-malformed");
    await mkdir(transaction, { recursive: true });
    await writeFile(join(transaction, "journal.json"), document, "utf8");
    await assert.rejects(recover(data));
    await writeFile(
      join(transaction, "journal.json"),
      JSON.stringify({ version: 1, phase: "committed", applied: 0, operations: [] }),
      "utf8",
    );
    await recover(data);
  }
});

test("recovery rolls back a transaction interrupted at each mutation boundary", async () => {
  for (const faultAfterOperation of [1, 2]) {
    const root = await temporary();
    const data = join(root, "data");
    const first = join(root, "first");
    const replacement = join(root, "replacement");
    await writePair(first, "a", "run-a");
    await ingest(first, data, source, "append", { now: () => "2026-09-13T01:00:00Z" });
    await writePair(replacement, "b", "run-b");
    await assert.rejects(
      ingest(replacement, data, source, "replace-case-version", {
        now: () => "2026-09-13T02:00:00Z",
        faultAfterOperation,
      }),
      /injected transaction fault/,
    );
    await recover(data);
    assert.equal(
      await stat(join(data, "results", "1.0.0", "demo", "run-a.json")).then(() => true),
      true,
    );
    await assert.rejects(stat(join(data, "results", "1.0.0", "demo", "run-b.json")), {
      code: "ENOENT",
    });
  }
});
