import { Schema } from "effect";

import { HttpUrl, NonEmptyString, type ValidationIssue } from "./common.js";

export const AnnotationSource = Schema.Struct({
  label: NonEmptyString,
  url: HttpUrl,
}).annotate({ identifier: "AnnotationSource" });

export const BenchmarkAnnotation = Schema.Struct({
  id: NonEmptyString,
  benchmark_id: NonEmptyString,
  introduced_in: NonEmptyString,
  metric_id: Schema.optionalKey(NonEmptyString),
  title: NonEmptyString,
  explanation: NonEmptyString,
  sources: Schema.Array(AnnotationSource),
}).annotate({ identifier: "BenchmarkAnnotation" });

export const AnnotationDocument = Schema.Struct({
  $schema: Schema.optionalKey(
    Schema.Literal("../schemas/current/annotations.schema.json"),
  ),
  annotations: Schema.Array(BenchmarkAnnotation),
}).annotate({ identifier: "AnnotationDocument", title: "LiteLLM benchmark annotations" });

export interface AnnotationCatalog {
  readonly benchmarks: ReadonlyMap<string, ReadonlySet<string>>;
  readonly acceptsVersion: (version: string) => boolean;
}

export function validateAnnotations(
  document: typeof AnnotationDocument.Type,
  catalog: AnnotationCatalog,
): ReadonlyArray<ValidationIssue> {
  const ids = document.annotations.map(({ id }) => id);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  return [
    ...duplicates.map((id) => ({ path: "annotations", message: `duplicate id: ${id}` })),
    ...document.annotations.flatMap((annotation, index) => {
      const path = `annotations.${index}`;
      const metrics = catalog.benchmarks.get(annotation.benchmark_id);
      return [
        ...(metrics === undefined
          ? [{ path: `${path}.benchmark_id`, message: "unknown benchmark" }]
          : []),
        ...(annotation.metric_id !== undefined && metrics !== undefined
            && !metrics.has(annotation.metric_id)
          ? [{ path: `${path}.metric_id`, message: "unknown metric" }]
          : []),
        ...(!catalog.acceptsVersion(annotation.introduced_in)
          ? [{ path: `${path}.introduced_in`, message: "invalid version" }]
          : []),
      ];
    }),
  ];
}

export type AnnotationDocument = typeof AnnotationDocument.Type;
export type BenchmarkAnnotation = typeof BenchmarkAnnotation.Type;
