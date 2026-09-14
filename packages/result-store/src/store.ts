import { NodeServices } from "@effect/platform-node";
import { createHash, randomUUID } from "node:crypto";

import {
  BenchmarkIndex,
  BenchmarkResult,
  canonicalJson,
  caseId,
  caseIdentityInput,
  CommittedRecord,
  comparisonId,
  decodeStrict,
  HostEnvironmentSnapshot,
  type JsonRecord,
  RunSpec,
  validateBenchmarkIndex,
  validateCommittedRecord,
  validateResultAgainstSpec,
} from "@litellm-bench/contracts";
import { Effect, FileSystem, Option, Path, Schema } from "effect";

const platform = await Effect.runPromise(
  Effect.all({ fileSystem: FileSystem.FileSystem, path: Path.Path }).pipe(
    Effect.provide(NodeServices.layer),
  ),
);
const fileSystem = platform.fileSystem;
const path = platform.path;
const run = Effect.runPromise;

export type WriteMode = "append" | "replace-case-version" | "replace-benchmark-version";

export interface StoreOptions {
  readonly now?: () => string;
  readonly faultAfterOperation?: number;
}

const WriteOperation = Schema.Struct({
  kind: Schema.Literal("write"),
  destination: Schema.String,
  staged: Schema.optionalKey(Schema.String),
  backup: Schema.optionalKey(Schema.String),
});

const DeleteOperation = Schema.Struct({
  kind: Schema.Literal("delete"),
  destination: Schema.String,
  staged: Schema.optionalKey(Schema.String),
  backup: Schema.optionalKey(Schema.String),
});

const Operation = Schema.Union([WriteOperation, DeleteOperation]);
type Operation = typeof Operation.Type;

const Journal = Schema.Struct({
  version: Schema.Literal(1),
  phase: Schema.Literals(["prepared", "applying", "committed"]),
  applied: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  operations: Schema.Array(Operation),
});
type Journal = typeof Journal.Type;

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const exists = (location: string): Promise<boolean> => run(fileSystem.exists(location));

const walkJson = async (directory: string): Promise<ReadonlyArray<string>> => {
  if (!await exists(directory)) return [];
  const entries = await run(fileSystem.readDirectory(directory));
  const nested = await Promise.all(entries.map(async (entry) => {
    const location = path.join(directory, entry);
    const info = await run(fileSystem.stat(location));
    return info.type === "Directory"
      ? walkJson(location)
      : entry.endsWith(".json")
      ? [location]
      : [];
  }));
  return nested.flat().sort();
};

const parseJson = async (path: string): Promise<unknown> =>
  JSON.parse(await run(fileSystem.readFileString(path)));

const slug = (value: string): string =>
  value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "unknown";

const digest = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value as JsonRecord)).digest("hex");

const validatePair = async (
  resultPath: string,
  source: JsonRecord,
): Promise<typeof CommittedRecord.Type> => {
  const specPath = path.join(path.dirname(resultPath), "benchmark-spec.json");
  if (!await exists(specPath)) throw new Error(`missing benchmark-spec.json beside ${resultPath}`);
  const spec = decodeStrict(RunSpec)(await parseJson(specPath));
  const result = decodeStrict(BenchmarkResult)(await parseJson(resultPath));
  const expectedCase = caseId(spec);
  const expectedComparison = comparisonId(spec);
  if (spec.case_id !== expectedCase || spec.comparison_id !== expectedComparison) {
    throw new Error(`${specPath}: identity does not match canonical experimental inputs`);
  }
  const resultIssues = validateResultAgainstSpec(result, spec);
  if (resultIssues.length > 0) {
    throw new Error(`${resultPath}: ${resultIssues[0]?.path}: ${resultIssues[0]?.message}`);
  }
  const identity = caseIdentityInput(spec) as unknown as JsonRecord;
  const record = decodeStrict(CommittedRecord)({
    record_id: digest({ domain: "record", case_id: spec.case_id, run_id: result.run_id }),
    case_id: spec.case_id,
    comparison_id: spec.comparison_id,
    identity,
    source,
    spec,
    result,
  });
  const issues = validateCommittedRecord(record);
  if (issues.length > 0) {
    throw new Error(`${resultPath}: ${issues[0]?.path}: ${issues[0]?.message}`);
  }
  return record;
};

const recordRelativePath = (record: typeof CommittedRecord.Type): string =>
  path.join(
    "results",
    slug(record.result.version),
    slug(record.result.benchmark.id),
    `${slug(record.result.run_id)}.json`,
  );

const readRecords = async (
  directory: string,
): Promise<ReadonlyArray<readonly [string, typeof CommittedRecord.Type]>> => {
  const paths = await walkJson(path.join(directory, "results"));
  return Promise.all(
    paths.map(async (path) =>
      [path, decodeStrict(CommittedRecord)(await parseJson(path))] as const
    ),
  );
};

export function buildIndex(
  records: ReadonlyArray<readonly [string, typeof CommittedRecord.Type]>,
  directory: string,
  generatedAt: string,
): typeof BenchmarkIndex.Type {
  const sorted = [...records].sort((left, right) =>
    right[1].result.created_at.localeCompare(left[1].result.created_at)
    || left[1].record_id.localeCompare(right[1].record_id)
  );
  const benchmarkById = new Map(
    sorted.map(([, record]) => [record.result.benchmark.id, record.result.benchmark]),
  );
  const index = decodeStrict(BenchmarkIndex)({
    generated_at: generatedAt,
    record_count: sorted.length,
    benchmarks: [...benchmarkById.values()].sort((a, b) => a.id.localeCompare(b.id)).map((
      { id, label, kind },
    ) => ({
      id,
      label,
      kind,
    })),
    records: sorted.map(([path, record]) => {
      const requirements = record.result.job.requirements;
      const host = Option.getOrUndefined(
        Schema.decodeUnknownOption(HostEnvironmentSnapshot)(record.result.apparatus.host),
      );
      const actualPlatform = host?.platform ?? requirements?.platform;
      const actualArchitecture = host?.architecture ?? requirements?.architecture;
      return {
        record_id: record.record_id,
        comparison_id: record.comparison_id,
        benchmark_id: record.result.benchmark.id,
        status: record.result.status,
        path: platform.path.relative(directory, path).split(platform.path.sep).join("/"),
        metrics: record.result.metrics,
        case_id: record.case_id,
        benchmark_label: record.result.benchmark.label,
        kind: record.result.benchmark.kind,
        created_at: record.result.created_at,
        job: record.result.job.id,
        canonical: record.result.job.canonical === true,
        version: record.result.version,
        ...(actualPlatform === undefined ? {} : { platform: actualPlatform }),
        ...(actualArchitecture === undefined
          ? {}
          : { architecture: actualArchitecture }),
        source: record.source,
      };
    }),
  });
  const issues = validateBenchmarkIndex(index);
  if (issues.length > 0) throw new Error(`${issues[0]?.path}: ${issues[0]?.message}`);
  return index;
}

const journalPath = (transaction: string): string => path.join(transaction, "journal.json");

const writeJournal = async (transaction: string, journal: Journal): Promise<void> => {
  await run(fileSystem.writeFileString(journalPath(transaction), json(journal)));
};

const rollback = async (
  directory: string,
  transaction: string,
  journal: Journal,
): Promise<void> => {
  for (const operation of [...journal.operations].reverse()) {
    const destination = path.join(directory, operation.destination);
    if (operation.backup !== undefined && await exists(path.join(transaction, operation.backup))) {
      await run(fileSystem.makeDirectory(path.dirname(destination), { recursive: true }));
      await run(fileSystem.copyFile(path.join(transaction, operation.backup), destination));
    } else {
      await run(fileSystem.remove(destination, { force: true }));
    }
  }
  await run(fileSystem.remove(transaction, { recursive: true, force: true }));
};

export async function recover(directory: string): Promise<void> {
  const transactionRoot = path.join(directory, ".result-store", "transactions");
  if (!await exists(transactionRoot)) return;
  const entries = await run(fileSystem.readDirectory(transactionRoot));
  const directories = (await Promise.all(entries.map(async (name) => ({
    name,
    info: await run(fileSystem.stat(path.join(transactionRoot, name))),
  })))).filter(({ info }) => info.type === "Directory");
  for (
    const entry of directories.sort((a, b) => a.name.localeCompare(b.name))
  ) {
    const transaction = path.join(transactionRoot, entry.name);
    if (!await exists(journalPath(transaction))) {
      await run(fileSystem.remove(transaction, { recursive: true, force: true }));
      continue;
    }
    const journal = decodeStrict(Schema.fromJsonString(Journal))(
      await run(fileSystem.readFileString(journalPath(transaction))),
    );
    if (journal.phase === "committed") {
      await run(fileSystem.remove(transaction, { recursive: true, force: true }));
    } else await rollback(directory, transaction, journal);
  }
}

const lock = async <T>(directory: string, body: () => Promise<T>): Promise<T> => {
  await run(fileSystem.makeDirectory(path.join(directory, ".result-store"), { recursive: true }));
  const lockPath = path.join(directory, ".result-store", "write.lock");
  try {
    await run(fileSystem.writeFileString(lockPath, "", { flag: "wx" }));
  } catch (error) {
    if (
      typeof error === "object" && error !== null && "reason" in error
      && typeof error.reason === "object" && error.reason !== null
      && "_tag" in error.reason && error.reason._tag === "AlreadyExists"
    ) {
      throw new Error(`result store is locked: ${directory}`);
    }
    throw error;
  }
  try {
    await recover(directory);
    return await body();
  } finally {
    await run(fileSystem.remove(lockPath, { force: true }));
  }
};

export async function ingest(
  inputDirectory: string,
  directory: string,
  source: JsonRecord,
  mode: WriteMode = "append",
  options: StoreOptions = {},
): Promise<number> {
  if (
    mode !== "append" && mode !== "replace-case-version" && mode !== "replace-benchmark-version"
  ) {
    throw new Error(`unsupported write mode: ${mode}`);
  }
  const resultPaths = (await walkJson(inputDirectory)).filter((path) =>
    path.endsWith(`${platform.path.sep}benchmark-result.json`)
  );
  const incoming = await Promise.all(resultPaths.map((path) => validatePair(path, source)));
  return lock(directory, async () => {
    const existing = await readRecords(directory);
    const caseReplacements = new Set(
      incoming.map((record) => `${record.case_id}\0${record.result.version}`),
    );
    const benchmarkReplacements = new Set(
      incoming.map((record) => `${record.result.benchmark.id}\0${record.result.version}`),
    );
    const obsolete = existing.filter(([, record]) =>
      mode === "replace-case-version"
        ? caseReplacements.has(`${record.case_id}\0${record.result.version}`)
        : mode === "replace-benchmark-version"
        ? benchmarkReplacements.has(`${record.result.benchmark.id}\0${record.result.version}`)
        : false
    );
    const obsoletePaths = new Set(obsolete.map(([path]) => path));
    const writable = mode === "replace-benchmark-version"
      ? incoming.filter((record) => record.result.status === "ok")
      : incoming;
    const writes = writable.flatMap((record) => {
      const destination = path.join(directory, recordRelativePath(record));
      const current = existing.find(([path]) => path === destination);
      if (current !== undefined && !obsoletePaths.has(destination)) {
        if (
          canonicalJson(current[1] as unknown as JsonRecord)
            !== canonicalJson(record as unknown as JsonRecord)
        ) {
          throw new Error(`conflicting record already exists: ${destination}`);
        }
        return [];
      }
      return [[destination, record] as const];
    });
    const changed = writes.length > 0 || obsolete.length > 0;
    if (!changed) return 0;
    const transaction = path.join(directory, ".result-store", "transactions", randomUUID());
    await run(fileSystem.makeDirectory(path.join(transaction, "staged"), { recursive: true }));
    const writeOperations = await Promise.all(
      writes.map(
        async ([destination, value], position) => {
          const staged = path.join("staged", `${position}.json`);
          await run(fileSystem.writeFileString(path.join(transaction, staged), json(value)));
          return {
            kind: "write" as const,
            destination: path.relative(directory, destination),
            staged,
          };
        },
      ),
    );
    const deleteOperations = obsolete.filter(([path]) =>
      !writes.some(([destination]) => destination === path)
    ).map(([path]) => ({
      kind: "delete" as const,
      destination: platform.path.relative(directory, path),
    }));
    const operations = [...deleteOperations, ...writeOperations];
    const preparedRoot = path.join(directory, ".result-store", "transactions");
    const transactionName = path.relative(preparedRoot, transaction);
    const targetTransaction = path.join(preparedRoot, transactionName);
    await executePreparedTransaction(directory, targetTransaction, operations, options);
    return writes.length;
  });
}

const executePreparedTransaction = async (
  directory: string,
  transaction: string,
  operations: ReadonlyArray<Omit<Operation, "backup">>,
  options: StoreOptions,
): Promise<void> => {
  await run(fileSystem.makeDirectory(path.join(transaction, "backup"), { recursive: true }));
  const prepared = await Promise.all(
    operations.map(async (operation, index): Promise<Operation> => {
      const destination = path.join(directory, operation.destination);
      const backup = await exists(destination) ? path.join("backup", `${index}.json`) : undefined;
      if (backup !== undefined) {
        await run(fileSystem.copyFile(destination, path.join(transaction, backup)));
      }
      return { ...operation, ...(backup === undefined ? {} : { backup }) };
    }),
  );
  let journal: Journal = { version: 1, phase: "applying", applied: 0, operations: prepared };
  await writeJournal(transaction, journal);
  for (const [index, operation] of prepared.entries()) {
    const destination = path.join(directory, operation.destination);
    if (operation.kind === "delete") await run(fileSystem.remove(destination, { force: true }));
    else {
      await run(fileSystem.makeDirectory(path.dirname(destination), { recursive: true }));
      await run(fileSystem.rename(path.join(transaction, operation.staged ?? ""), destination));
    }
    journal = { ...journal, applied: index + 1 };
    await writeJournal(transaction, journal);
    if (options.faultAfterOperation === index + 1) {
      throw new Error(`injected transaction fault after operation ${index + 1}`);
    }
  }
  await writeJournal(transaction, { ...journal, phase: "committed" });
  await run(fileSystem.remove(transaction, { recursive: true, force: true }));
};

export async function rebuildIndex(
  directory: string,
  options: StoreOptions = {},
): Promise<typeof BenchmarkIndex.Type> {
  return lock(directory, async () => {
    const records = await readRecords(directory);
    const index = buildIndex(records, directory, options.now?.() ?? new Date().toISOString());
    await run(fileSystem.writeFileString(path.join(directory, "index.json"), json(index)));
    return index;
  });
}

export async function deriveIndex(
  directory: string,
  options: StoreOptions = {},
): Promise<typeof BenchmarkIndex.Type> {
  const records = await readRecords(directory);
  return buildIndex(records, directory, options.now?.() ?? new Date().toISOString());
}

export const ingestEffect = (
  inputDirectory: string,
  directory: string,
  source: JsonRecord,
  mode: WriteMode = "append",
  options: StoreOptions = {},
) =>
  Effect.tryPromise({
    try: () => ingest(inputDirectory, directory, source, mode, options),
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  });

export const rebuildIndexEffect = (directory: string, options: StoreOptions = {}) =>
  Effect.tryPromise({
    try: () => rebuildIndex(directory, options),
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  });
