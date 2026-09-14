import {
  type BenchmarkDefinition,
  caseId,
  comparisonId,
  type JsonRecord,
  type RunSpec,
} from "@litellm-bench/contracts";
import {
  publishedStableReleases,
  type ResolvedRelease,
  resolveVersion,
} from "@litellm-bench/versions";
import { Data, Effect, Schema } from "effect";
import { createHash } from "node:crypto";

export const PlanEntry = Schema.Struct({
  job_id: Schema.NonEmptyString,
  benchmark_id: Schema.NonEmptyString,
  benchmark_job: Schema.NonEmptyString,
  runner: Schema.NonEmptyString,
});

export type PlanEntry = typeof PlanEntry.Type;

export const VersionJob = Schema.Struct({
  version: Schema.NonEmptyString,
  runner: Schema.Literal("ubuntu-24.04"),
  jobs: Schema.NonEmptyArray(PlanEntry),
  needs_proxy: Schema.Boolean,
  comparison_order: Schema.Struct({
    method: Schema.Literal("seeded-fisher-yates"),
    position: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
    total: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
    seed_sha256: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  }),
});

export type VersionJob = typeof VersionJob.Type;

export interface VersionMatrix {
  readonly include: ReadonlyArray<VersionJob>;
}

export interface SuiteBenchmark {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly artifact: string;
  readonly definition: BenchmarkDefinition;
}

export class SuiteError extends Data.TaggedError("SuiteError")<{
  readonly message: string;
}> {}

const PYPI_PROJECT_URL = "https://pypi.org/pypi/litellm/json";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;

export const discoverStableVersions = (
  backfillMonths: number | undefined,
): Effect.Effect<string, SuiteError> => {
  if (
    backfillMonths !== undefined
    && (!Number.isSafeInteger(backfillMonths) || backfillMonths < 1)
  ) {
    return Effect.fail(new SuiteError({ message: "backfill-months must be a positive integer" }));
  }
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(PYPI_PROJECT_URL, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`PyPI returned HTTP ${response.status}`);
      return response.json();
    },
    catch: (error) =>
      new SuiteError({
        message: `cannot discover LiteLLM releases: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
  }).pipe(
    Effect.flatMap((metadata) => {
      const stable = publishedStableReleases(metadata);
      const selected = backfillMonths === undefined
        ? stable.slice(-1)
        : stable.filter(({ publishedAt }) =>
          Date.parse(publishedAt) >= Date.now() - backfillMonths * THIRTY_DAYS_MS
        );
      return selected.length === 0
        ? Effect.fail(
          new SuiteError({
            message: backfillMonths === undefined
              ? "PyPI did not return a stable LiteLLM release"
              : `PyPI did not return stable LiteLLM releases from the last ${backfillMonths} month(s)`,
          }),
        )
        : Effect.succeed(selected.map(({ version }) => version).join(","));
    }),
  );
};

export const selectVersions = (
  versions: string | undefined,
  backfillMonths: number | undefined,
): Effect.Effect<string, SuiteError> => {
  if (versions !== undefined && backfillMonths !== undefined) {
    return Effect.fail(
      new SuiteError({ message: "versions and backfill-months cannot be used together" }),
    );
  }
  return versions === undefined
    ? discoverStableVersions(backfillMonths)
    : Effect.succeed(versions);
};

const slug = (...parts: ReadonlyArray<string>): string =>
  parts.join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const selectedBenchmarks = <Benchmark extends SuiteBenchmark>(
  benchmarks: ReadonlyArray<Benchmark>,
  selection: string,
): Effect.Effect<ReadonlyArray<Benchmark>, SuiteError> => {
  if (selection === "all") return Effect.succeed(benchmarks);
  if (selection === "sdk" || selection === "proxy") {
    return Effect.succeed(benchmarks.filter(({ kind }) => kind === selection));
  }
  const ids = [...new Set(selection.split(","))];
  if (ids.length === 0 || ids.some((id) => id.length === 0)) {
    return Effect.fail(new SuiteError({ message: "selection contains an empty benchmark ID" }));
  }
  const unknown = ids.filter((id) => !benchmarks.some((benchmark) => benchmark.id === id));
  return unknown.length > 0
    ? Effect.fail(
      new SuiteError({ message: `unknown benchmark ids: ${unknown.sort().join(", ")}` }),
    )
    : Effect.succeed(benchmarks.filter(({ id }) => ids.includes(id)));
};

const resolvedVersions = (
  versions: string,
): Effect.Effect<ReadonlyArray<readonly [string, ResolvedRelease]>, SuiteError> => {
  const names = [...new Set(versions.split(","))];
  if (names.length === 0 || names.some((name) => name.length === 0)) {
    return Effect.fail(new SuiteError({ message: "versions contains an empty release" }));
  }
  if (names.length > 256) {
    return Effect.fail(new SuiteError({ message: "a dispatch supports at most 256 versions" }));
  }
  const values = names.map((name) => [name, resolveVersion(name)] as const);
  const invalid = values.find(([, resolution]) => resolution._tag === "InvalidVersion");
  if (invalid !== undefined && invalid[1]._tag === "InvalidVersion") {
    return Effect.fail(new SuiteError({ message: invalid[1].message }));
  }
  const releases = values.map(([name, resolution]) =>
    [
      name,
      (resolution as Extract<typeof resolution, { readonly _tag: "Resolved" }>).release,
    ] as const
  );
  const duplicate = releases.find(([, release], index) =>
    releases.findIndex(([, candidate]) => candidate.version === release.version) !== index
  );
  return duplicate === undefined
    ? Effect.succeed(releases)
    : Effect.fail(
      new SuiteError({ message: `multiple release aliases resolve to ${duplicate[1].version}` }),
    );
};

const artifactFor = (
  benchmark: SuiteBenchmark,
  release: ResolvedRelease,
): JsonRecord | undefined => {
  if (benchmark.artifact === "sdk" && release.sdk !== null) {
    return {
      requirement: release.sdk.requirement,
      distribution: release.sdk.distribution,
    };
  }
  if (benchmark.artifact === "proxy") return { image: release.proxy.image };
  return undefined;
};

const releaseArtifacts = (release: ResolvedRelease): JsonRecord => ({
  ...(release.sdk === null
    ? {}
    : {
      sdk: {
        requirement: release.sdk.requirement,
        distribution: release.sdk.distribution,
      },
    }),
  proxy: { image: release.proxy.image },
});

const shuffled = <T>(values: readonly T[], seed: string): T[] => {
  const output = [...values];
  let state = Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16);
  for (let index = output.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const target = state % (index + 1);
    [output[index], output[target]] = [output[target]!, output[index]!];
  }
  return output;
};

export const buildVersionMatrix = <Benchmark extends SuiteBenchmark>(
  benchmarks: ReadonlyArray<Benchmark>,
  versions: string,
  selection: string,
  orderSeed = "local",
): Effect.Effect<VersionMatrix, SuiteError> =>
  Effect.gen(function*() {
    const selected = yield* selectedBenchmarks(benchmarks, selection);
    const releases = shuffled(yield* resolvedVersions(versions), orderSeed);
    const seedSha256 = createHash("sha256").update(orderSeed).digest("hex");
    return {
      include: releases.flatMap(([requested, release], index) => {
        const jobs = selected.flatMap((benchmark) =>
          artifactFor(benchmark, release) === undefined
            ? []
            : benchmark.definition.jobs.map((job): PlanEntry => ({
              job_id: slug(benchmark.id, release.version, job.id),
              benchmark_id: benchmark.id,
              benchmark_job: job.id,
              runner: job.runner,
            }))
        );
        return jobs.length === 0
          ? []
          : [{
            version: requested,
            runner: "ubuntu-24.04" as const,
            jobs: jobs as [PlanEntry, ...PlanEntry[]],
            needs_proxy: jobs.some((job) =>
              selected.some(({ id, artifact }) => id === job.benchmark_id && artifact === "proxy")
            ),
            comparison_order: {
              method: "seeded-fisher-yates" as const,
              position: index + 1,
              total: releases.length,
              seed_sha256: seedSha256,
            },
          }];
      }),
    };
  });

export const makeRunSpec = (
  benchmark: SuiteBenchmark,
  jobId: string,
  release: ResolvedRelease,
): Effect.Effect<RunSpec, SuiteError> => {
  const job = benchmark.definition.jobs.find(({ id }) => id === jobId);
  const artifact = artifactFor(benchmark, release);
  if (job === undefined) {
    return Effect.fail(new SuiteError({ message: `unknown job ${jobId} for ${benchmark.id}` }));
  }
  if (artifact === undefined) {
    return Effect.fail(
      new SuiteError({
        message:
          `version ${release.version} has no ${benchmark.artifact} artifact for ${benchmark.id}`,
      }),
    );
  }
  const provisional: RunSpec = {
    case_id: "0".repeat(64),
    comparison_id: "0".repeat(64),
    benchmark: {
      id: benchmark.id,
      label: benchmark.label,
      kind: benchmark.kind,
      output_metrics: benchmark.definition.output_metrics,
      protocol: benchmark.definition.protocol,
    },
    job,
    version: {
      version: release.version,
      artifacts: releaseArtifacts(release),
    },
    artifact,
  };
  return Effect.succeed({
    ...provisional,
    case_id: caseId(provisional),
    comparison_id: comparisonId(provisional),
  });
};
