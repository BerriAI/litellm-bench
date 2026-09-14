import { Schema } from "effect";

import {
  Better,
  FiniteNumber,
  JsonObject,
  type JsonRecord,
  NonEmptyString,
  PositiveInteger,
  Sha256Id,
  Timestamp,
  type ValidationIssue,
} from "./common.js";
import { canonicalJson } from "./identity.js";
import {
  EnvironmentRequirements,
  MeasurementProtocol,
  OutputMetricDefinition,
} from "./metadata.js";

export const BenchmarkSnapshot = Schema.Struct({
  id: NonEmptyString,
  label: NonEmptyString,
  kind: NonEmptyString,
  output_metrics: Schema.Array(OutputMetricDefinition),
  protocol: MeasurementProtocol,
}).annotate({ identifier: "BenchmarkSnapshot" });

export const JobSnapshot = Schema.Struct({
  id: NonEmptyString,
  canonical: Schema.optionalKey(Schema.Boolean),
  runner: NonEmptyString,
  config: JsonObject,
  requirements: Schema.optionalKey(EnvironmentRequirements),
}).annotate({ identifier: "JobSnapshot" });

export const VersionSelection = Schema.Struct({
  version: NonEmptyString,
  artifacts: JsonObject,
}).annotate({ identifier: "VersionSelection" });

export const RunSpec = Schema.Struct({
  case_id: Sha256Id,
  comparison_id: Sha256Id,
  benchmark: BenchmarkSnapshot,
  job: JobSnapshot,
  version: VersionSelection,
  artifact: JsonObject,
}).annotate({ identifier: "RunSpec", title: "LiteLLM benchmark run specification" });

export const Metric = Schema.Struct({
  id: NonEmptyString,
  label: NonEmptyString,
  value: FiniteNumber,
  unit: Schema.String,
  better: Better,
  group: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Metric" });

export const Trial = Schema.Struct({
  id: NonEmptyString,
  scenario: NonEmptyString,
  valid: Schema.Boolean,
  measurements: Schema.Record(Schema.String, FiniteNumber),
  attempt: Schema.optionalKey(PositiveInteger),
  round: Schema.optionalKey(PositiveInteger),
  variant: Schema.optionalKey(Schema.String),
  dimensions: Schema.optionalKey(JsonObject),
  request_counts: Schema.optionalKey(JsonObject),
  invalid_reason: Schema.optionalKey(NonEmptyString),
}).annotate({ identifier: "Trial" });

export const Analysis = Schema.Struct({
  id: NonEmptyString,
  measurement: NonEmptyString,
  aggregation: NonEmptyString,
  payload: JsonObject,
}).annotate({ identifier: "Analysis" });

export const ResultFailure = Schema.Struct({
  code: Schema.Literals([
    "invalid_config",
    "artifact_unavailable",
    "registry_request_failed",
    "environment_requirement_unmet",
    "process_failed",
    "deadline_exceeded",
    "invalid_observation",
    "record_conflict",
    "persistence_failed",
    "cancelled",
  ]),
  message: Schema.String,
  details: Schema.optionalKey(JsonObject),
}).annotate({ identifier: "ResultFailure" });

const ResultFields = {
  run_id: NonEmptyString,
  created_at: Timestamp,
  case_id: Sha256Id,
  comparison_id: Sha256Id,
  benchmark: BenchmarkSnapshot,
  job: JobSnapshot,
  version: NonEmptyString,
  artifact: JsonObject,
  apparatus: JsonObject,
  metrics: Schema.Array(Metric),
  trials: Schema.Array(Trial),
  analyses: Schema.Array(Analysis),
  details: Schema.optionalKey(JsonObject),
} as const;

export const SuccessfulResult = Schema.Struct({
  ...ResultFields,
  status: Schema.Literal("ok"),
}).annotate({ identifier: "SuccessfulResult" });

export const FailedResult = Schema.Struct({
  ...ResultFields,
  status: Schema.Literal("failed"),
  error: ResultFailure,
}).annotate({ identifier: "FailedResult" });

export const BenchmarkResult = Schema.Union([SuccessfulResult, FailedResult], {
  mode: "oneOf",
}).annotate({ identifier: "BenchmarkResult", title: "LiteLLM benchmark result" });

export const CommittedRecord = Schema.Struct({
  record_id: Sha256Id,
  case_id: Sha256Id,
  comparison_id: Sha256Id,
  identity: JsonObject,
  source: JsonObject,
  spec: RunSpec,
  result: BenchmarkResult,
}).annotate({ identifier: "CommittedRecord", title: "LiteLLM committed benchmark record" });

export const IndexBenchmark = Schema.Struct({
  id: NonEmptyString,
  label: NonEmptyString,
  kind: NonEmptyString,
}).annotate({ identifier: "IndexBenchmark" });

export const IndexRecord = Schema.Struct({
  record_id: Sha256Id,
  comparison_id: Sha256Id,
  benchmark_id: NonEmptyString,
  status: Schema.Literals(["ok", "failed"]),
  path: NonEmptyString,
  metrics: Schema.Array(Metric),
  case_id: Sha256Id,
  benchmark_label: NonEmptyString,
  kind: NonEmptyString,
  created_at: Timestamp,
  job: NonEmptyString,
  canonical: Schema.optionalKey(Schema.Boolean),
  version: NonEmptyString,
  platform: Schema.optionalKey(NonEmptyString),
  architecture: Schema.optionalKey(NonEmptyString),
  source: JsonObject,
}).annotate({ identifier: "IndexRecord" });

export const BenchmarkIndex = Schema.Struct({
  generated_at: Timestamp,
  record_count: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  benchmarks: Schema.Array(IndexBenchmark),
  records: Schema.Array(IndexRecord),
}).annotate({ identifier: "BenchmarkIndex", title: "LiteLLM benchmark index" });

const equalJson = (left: unknown, right: unknown): boolean =>
  canonicalJson(left as JsonRecord) === canonicalJson(right as JsonRecord);

export function validateResultAgainstSpec(
  result: typeof BenchmarkResult.Type,
  spec: typeof RunSpec.Type,
): ReadonlyArray<ValidationIssue> {
  const fields: ReadonlyArray<readonly [string, unknown, unknown]> = [
    ["case_id", result.case_id, spec.case_id],
    ["comparison_id", result.comparison_id, spec.comparison_id],
    ["benchmark", result.benchmark, spec.benchmark],
    ["job", result.job, spec.job],
    ["version", result.version, spec.version.version],
    ["artifact", result.artifact, spec.artifact],
  ];
  const mismatches = fields.flatMap(([path, actual, expected]) =>
    equalJson(actual, expected) ? [] : [{ path, message: "does not match run specification" }]
  );
  const declarations = new Map(
    result.benchmark.output_metrics.map((metric) => [metric.id, metric]),
  );
  const metricIds = result.metrics.map(({ id }) => id);
  const duplicateMetricIds = [
    ...new Set(metricIds.filter((id, index) => metricIds.indexOf(id) !== index)),
  ];
  const metricIssues = result.status === "failed" ? [] : [
    ...duplicateMetricIds.map((id) => ({ path: "metrics", message: `duplicate metric: ${id}` })),
    ...result.metrics.flatMap((metric) => {
      const declared = declarations.get(metric.id);
      if (declared === undefined) {
        return [{ path: `metrics.${metric.id}`, message: "undeclared metric" }];
      }
      return declared.unit === metric.unit && declared.better === metric.better
        ? []
        : [{
          path: `metrics.${metric.id}`,
          message: "unit or direction differs from output contract",
        }];
    }),
    ...result.benchmark.output_metrics.filter(({ id }) => !metricIds.includes(id)).map((
      { id },
    ) => ({
      path: "metrics",
      message: `missing metric: ${id}`,
    })),
  ];
  return [...mismatches, ...metricIssues];
}

export function validateCommittedRecord(
  record: typeof CommittedRecord.Type,
): ReadonlyArray<ValidationIssue> {
  const referenceIssues = (["case_id", "comparison_id"] as const).flatMap((key) =>
    record[key] === record.spec[key] && record[key] === record.result[key]
      ? []
      : [{ path: key, message: "record, spec, and result references differ" }]
  );
  return [...referenceIssues, ...validateResultAgainstSpec(record.result, record.spec)];
}

export function validateBenchmarkIndex(
  index: typeof BenchmarkIndex.Type,
): ReadonlyArray<ValidationIssue> {
  const recordIds = index.records.map(({ record_id }) => record_id);
  const duplicateRecordIds = [
    ...new Set(recordIds.filter((id, position) => recordIds.indexOf(id) !== position)),
  ];
  return [
    ...(index.record_count === index.records.length
      ? []
      : [{ path: "record_count", message: `expected ${index.records.length}` }]),
    ...duplicateRecordIds.map((id) => ({ path: "records", message: `duplicate record_id: ${id}` })),
  ];
}

export type RunSpec = typeof RunSpec.Type;
export type BenchmarkResult = typeof BenchmarkResult.Type;
export type CommittedRecord = typeof CommittedRecord.Type;
export type BenchmarkIndex = typeof BenchmarkIndex.Type;
export type Metric = typeof Metric.Type;
export type Trial = typeof Trial.Type;
export type Analysis = typeof Analysis.Type;
export type ResultFailure = typeof ResultFailure.Type;
export type Artifact = JsonRecord;
