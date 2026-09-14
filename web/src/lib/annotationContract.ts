import { benchmarkCatalog } from "@litellm-bench/catalog";
import { decodeStrict } from "@litellm-bench/contracts";
import {
  AnnotationDocument,
  type BenchmarkAnnotation,
  validateAnnotations,
} from "@litellm-bench/contracts/annotations";
import { normalizedVersion } from "@litellm-bench/versions";

const annotationCatalog = {
  benchmarks: new Map(
    Object.entries(benchmarkCatalog).map(([id, benchmark]) => [
      id,
      new Set(Object.keys(benchmark.metrics)),
    ]),
  ),
  acceptsVersion: (version: string) => normalizedVersion(version) !== null,
};

export function parseAnnotations(value: unknown): BenchmarkAnnotation[] {
  try {
    const document = decodeStrict(AnnotationDocument)(value);
    const issues = validateAnnotations(document, annotationCatalog);
    if (issues.length) {
      throw new Error(issues.map((issue) => `${issue.path}: ${issue.message}`).join(", "));
    }
    return [...document.annotations];
  } catch (error) {
    throw new Error(`Invalid benchmark annotations: ${String(error)}`, { cause: error });
  }
}
