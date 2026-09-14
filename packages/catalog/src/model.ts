import type { BenchmarkDefinition } from "@litellm-bench/contracts/metadata";

export interface CatalogMetric {
  readonly unit: string;
  readonly better: "higher" | "lower" | "neutral";
}

export interface BenchmarkCatalogEntry {
  readonly label: string;
  readonly kind: string;
  readonly artifact: string;
  readonly canonicalJob: string;
  readonly canonicalRunner: string;
  readonly metrics: Readonly<Record<string, CatalogMetric>>;
  readonly definition: BenchmarkDefinition;
}

export type BenchmarkCatalog = Readonly<Record<string, BenchmarkCatalogEntry>>;

export interface LocatedBenchmarkDefinition {
  readonly directory: string;
  readonly definition: BenchmarkDefinition;
}

export interface CatalogIssue {
  readonly path: string;
  readonly message: string;
}

export type CatalogBuildResult =
  | { readonly _tag: "Catalog"; readonly value: BenchmarkCatalog }
  | { readonly _tag: "InvalidCatalog"; readonly issues: readonly CatalogIssue[] };

function issuesForDefinition(item: LocatedBenchmarkDefinition): readonly CatalogIssue[] {
  const { definition, directory } = item;
  const canonicalJobs = definition.jobs.filter((job) => job.canonical === true);
  return [
    ...(definition.id === directory ? [] : [{
      path: `${directory}/benchmark.json.id`,
      message: `benchmark id ${JSON.stringify(definition.id)} must match directory name`,
    }]),
    ...(canonicalJobs.length === 1 ? [] : [{
      path: `${directory}/benchmark.json.jobs`,
      message: "benchmark must declare exactly one canonical job",
    }]),
  ];
}

export function buildCatalog(
  definitions: readonly LocatedBenchmarkDefinition[],
): CatalogBuildResult {
  const ids = definitions.map(({ definition }) => definition.id);
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  const issues = [
    ...definitions.flatMap(issuesForDefinition),
    ...duplicateIds.map((id) => ({ path: "benchmarks", message: `duplicate benchmark id: ${id}` })),
  ];
  if (issues.length) return { _tag: "InvalidCatalog", issues };
  const entries = definitions.map(({ definition }) => {
    const canonical = definition.jobs.find((job) => job.canonical === true);
    if (!canonical) return null;
    return [definition.id, {
      label: definition.label ?? definition.id,
      kind: definition.kind,
      artifact: definition.artifact,
      canonicalJob: canonical.id,
      canonicalRunner: canonical.runner,
      metrics: Object.fromEntries(definition.output_metrics.map((metric) => [metric.id, {
        unit: metric.unit,
        better: metric.better,
      }])),
      definition,
    }] as const;
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  return { _tag: "Catalog", value: Object.fromEntries(entries) };
}
