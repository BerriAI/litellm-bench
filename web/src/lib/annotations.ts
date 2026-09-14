import type { BenchmarkAnnotation } from "@litellm-bench/contracts/annotations";
import type { TopLevelSpec } from "vega-lite";
import { chartPresentation } from "../styles/charts.ts";
import type { BenchmarkRecord } from "./data";
import { median, observations } from "./observations.ts";
import { compareVersions, normalizedVersion, uniqueVersions } from "./versions.ts";

export type { BenchmarkAnnotation };

export interface ResolvedAnnotation {
  annotation: BenchmarkAnnotation;
  number: number;
  value: number | null;
  version: string;
  between: boolean;
}

export function resolveAnnotations(
  records: BenchmarkRecord[],
  metricIds?: readonly string[],
  annotations: readonly BenchmarkAnnotation[] = [],
): ResolvedAnnotation[] {
  const values = observations(records);
  return annotations.flatMap((annotation, index) => {
    if (annotation.metric_id && metricIds && !metricIds.includes(annotation.metric_id)) return [];
    const chartValues = values.filter((item) =>
      item.benchmarkId === annotation.benchmark_id
      && (!metricIds || metricIds.includes(item.metricId))
    );
    const scoped = chartValues.filter((item) =>
      !annotation.metric_id || annotation.metric_id === item.metricId
    );
    if (!scoped.length) return [];
    const versions = uniqueVersions(chartValues.map((item) => item.version)).filter(
      normalizedVersion,
    );
    const version = versions.find((item) => compareVersions(item, annotation.introduced_in) >= 0);
    if (!version) return [];
    const between = compareVersions(version, annotation.introduced_in) !== 0;
    if (between && versions.indexOf(version) === 0) return [];
    const to = scoped.filter((item) => item.version === version);
    const keys = [...new Set(to.map((item) => item.key))];
    const anchored = !between && Boolean(annotation.metric_id && keys.length === 1);
    return [{
      annotation,
      number: index + 1,
      version,
      between,
      value: anchored
        ? median(to.filter((item) => item.key === keys[0]).map((item) => item.value)) ?? null
        : null,
    }];
  });
}

type AnnotationLayer = Extract<TopLevelSpec, { layer: unknown }>["layer"][number];

export function annotationLayers(
  annotations: ResolvedAnnotation[],
  color: string,
): AnnotationLayer[] {
  return annotations.flatMap(
    ({ annotation, number, value, version, between }, index): AnnotationLayer[] => {
      const slot =
        annotations.slice(0, index).filter((item) =>
          item.version === version && item.between === between
        ).length;
      const encoding = {
        color: { value: color },
        x: {
          datum: version,
          type: "ordinal" as const,
          bandPosition: between ? 0 : 0.5,
          scale: { type: "band" as const, paddingInner: 0, paddingOuter: 0.5 },
        },
        ...(value === null ? {} : { y: { datum: value, type: "quantitative" as const } }),
        tooltip: {
          value:
            `${number}. ${annotation.title}\nIntroduced in ${annotation.introduced_in}\n${annotation.explanation}`,
        },
        description: {
          value:
            `${number}. ${annotation.title}, introduced in ${annotation.introduced_in}: ${annotation.explanation}`,
        },
        ...(annotation.sources[0] ? { href: { value: annotation.sources[0].url } } : {}),
      };
      const label: AnnotationLayer = {
        data: { values: [{}] },
        mark: {
          type: "text",
          dy: value === null
            ? slot * chartPresentation.annotationOffset
            : -(slot + 1) * chartPresentation.annotationOffset,
          fontWeight: "bold",
        },
        encoding: {
          ...encoding,
          ...(value === null ? { y: { value: chartPresentation.annotationTop } } : {}),
          text: { value: `[${number}]` },
        },
      };
      if (value !== null) {
        return [label];
      }
      const rule: AnnotationLayer = {
        data: { values: [{}] },
        mark: { type: "rule", strokeDash: [...chartPresentation.annotationDash], aria: false },
        encoding,
      };
      return [rule, label];
    },
  );
}
