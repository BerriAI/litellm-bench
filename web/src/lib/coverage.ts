import { isCanonical } from "@litellm-bench/analysis";
import { benchmarkCatalog } from "@litellm-bench/catalog";
import { uniqueVersions } from "@litellm-bench/versions";
import type { BenchmarkRecord } from "./data";

export type CoverageState = "published" | "failed" | "missing";

export interface VersionCoverage {
  readonly version: string;
  readonly state: CoverageState;
  /** Canonical records of this benchmark at this version, newest first. */
  readonly records: readonly BenchmarkRecord[];
  readonly detail: string;
}

export interface CoverageSummary {
  readonly versions: readonly VersionCoverage[];
  readonly published: number;
  readonly failed: number;
  readonly missing: number;
}

const describeFailure = (record: BenchmarkRecord): string =>
  record.failure === undefined
    ? `${record.job}: failed without a recorded error`
    : `${record.job}: ${record.failure.code} — ${record.failure.message}`;

/**
 * Reconciles the versions that have evidence anywhere in the data set against the canonical
 * records of one benchmark. A version is `published` when at least one canonical run succeeded,
 * `failed` when every canonical run at that version failed, and `missing` when the version was
 * benchmarked elsewhere but this benchmark left no record at all.
 */
export function benchmarkCoverage(
  records: readonly BenchmarkRecord[],
  knownVersions: readonly (string | null | undefined)[],
): CoverageSummary {
  const canonical = records.filter((record) => isCanonical(record, benchmarkCatalog));
  const versions = uniqueVersions([
    ...knownVersions,
    ...records.map((record) => record.version),
  ]).map((version): VersionCoverage => {
    const matching = canonical
      .filter((record) => record.version === version)
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
    if (matching.some((record) => record.status === "ok")) {
      const failed = matching.filter((record) => record.status === "failed");
      return {
        version,
        state: "published",
        records: matching,
        detail: failed.length === 0
          ? `${matching.length} successful ${matching.length === 1 ? "run" : "runs"}`
          : `${matching.length - failed.length} successful, ${failed.length} failed`,
      };
    }
    if (matching.length > 0) {
      return {
        version,
        state: "failed",
        records: matching,
        detail: matching.map(describeFailure).join("; "),
      };
    }
    return {
      version,
      state: "missing",
      records: [],
      detail: "No canonical result was published for this version",
    };
  });
  return {
    versions,
    published: versions.filter(({ state }) => state === "published").length,
    failed: versions.filter(({ state }) => state === "failed").length,
    missing: versions.filter(({ state }) => state === "missing").length,
  };
}
