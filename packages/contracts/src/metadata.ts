import { Schema } from "effect";

import {
  Better,
  FiniteNumber,
  JsonObject,
  type JsonRecord,
  NonEmptyString,
  NonNegativeInteger,
  PositiveInteger,
  type ValidationIssue,
} from "./common.js";

export const DockerRequirements = Schema.Struct({
  architecture: Schema.Literals(["x86_64", "arm64"]),
  cgroup_version: Schema.optionalKey(Schema.Literal("2")),
  ports: Schema.optionalKey(Schema.Array(PositiveInteger)),
}).annotate({ identifier: "DockerRequirements" });

export const EnvironmentRequirements = Schema.Struct({
  platform: Schema.optionalKey(Schema.Literals(["linux", "macos", "windows"])),
  architecture: Schema.optionalKey(Schema.Literals(["x86_64", "arm64"])),
  python: Schema.optionalKey(NonEmptyString),
  tools: Schema.optionalKey(Schema.Array(Schema.Literals(["uv", "k6"]))),
  host: Schema.optionalKey(Schema.Literals(["existing", "github-hosted"])),
  docker: Schema.optionalKey(DockerRequirements),
}).annotate({ identifier: "EnvironmentRequirements" });

export const HostEnvironmentSnapshot = Schema.Struct({
  platform: Schema.Literals(["linux", "macos", "windows", "unknown"]),
  architecture: Schema.Literals(["x86_64", "arm64", "unknown"]),
  host: Schema.Literals(["existing", "github-hosted"]),
  node_version: NonEmptyString,
  python_version: Schema.optionalKey(NonEmptyString),
  python_implementation: Schema.optionalKey(NonEmptyString),
  ci: Schema.Boolean,
  kernel_release: Schema.optionalKey(NonEmptyString),
  cpu_model: Schema.optionalKey(NonEmptyString),
  cpu_count: Schema.optionalKey(PositiveInteger),
  memory_total_bytes: Schema.optionalKey(NonNegativeInteger),
  load_average_1m: Schema.optionalKey(FiniteNumber),
}).annotate({ identifier: "HostEnvironmentSnapshot" });

export const OutputMetricDefinition = Schema.Struct({
  id: NonEmptyString,
  unit: NonEmptyString,
  better: Better,
}).annotate({ identifier: "OutputMetricDefinition" });

export const ProtocolScenario = Schema.Struct({
  id: NonEmptyString,
  label: NonEmptyString,
  dimensions: JsonObject,
}).annotate({ identifier: "ProtocolScenario" });

export const ProtocolMeasurement = Schema.Struct({
  id: NonEmptyString,
  label: NonEmptyString,
  unit: NonEmptyString,
  role: Schema.Literals(["primary", "secondary", "diagnostic"]),
  better: Schema.optionalKey(Better),
}).annotate({ identifier: "ProtocolMeasurement" });

export const ProtocolAnalysis = Schema.Struct({
  id: NonEmptyString,
  label: NonEmptyString,
  measurement: NonEmptyString,
  additional_measurements: Schema.optionalKey(Schema.Array(NonEmptyString)),
  scenarios: Schema.optionalKey(Schema.Array(NonEmptyString)),
  group_by: Schema.optionalKey(Schema.Array(NonEmptyString)),
  pair_by: Schema.optionalKey(Schema.Array(NonEmptyString)),
  operation: Schema.optionalKey(NonEmptyString),
  aggregation: NonEmptyString,
  report: Schema.optionalKey(Schema.Array(NonEmptyString)),
}).annotate({ identifier: "ProtocolAnalysis" });

export const ProtocolAttempts = Schema.Struct({
  count: PositiveInteger,
  count_from: NonEmptyString,
  isolation: Schema.optionalKey(NonEmptyString),
  order: Schema.optionalKey(NonEmptyString),
  pair_by: Schema.optionalKey(Schema.Array(NonEmptyString)),
  retention: Schema.optionalKey(NonEmptyString),
  trials_per_attempt: Schema.optionalKey(PositiveInteger),
  unit: Schema.optionalKey(NonEmptyString),
  warmups: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
}).annotate({ identifier: "ProtocolAttempts" });

export const ProtocolVariant = Schema.Struct({
  id: NonEmptyString,
  label: NonEmptyString,
  settings: JsonObject,
}).annotate({ identifier: "ProtocolVariant" });

export const MeasurementProtocol = Schema.Struct({
  question: NonEmptyString,
  claim_scope: Schema.optionalKey(NonEmptyString),
  experimental_unit: Schema.optionalKey(NonEmptyString),
  scenarios: Schema.Array(ProtocolScenario),
  attempts: Schema.optionalKey(ProtocolAttempts),
  measurements: Schema.Array(ProtocolMeasurement),
  analyses: Schema.Array(ProtocolAnalysis),
  validity: Schema.optionalKey(JsonObject),
  variants: Schema.optionalKey(Schema.Array(ProtocolVariant)),
}).annotate({ identifier: "MeasurementProtocol" });

export const BenchmarkJob = Schema.Struct({
  id: NonEmptyString,
  canonical: Schema.optionalKey(Schema.Boolean),
  runner: NonEmptyString,
  config: JsonObject,
  requirements: Schema.optionalKey(EnvironmentRequirements),
}).annotate({ identifier: "BenchmarkJob" });

export const BenchmarkDefinition = Schema.Struct({
  $schema: Schema.optionalKey(NonEmptyString),
  id: NonEmptyString,
  label: Schema.optionalKey(NonEmptyString),
  kind: NonEmptyString,
  artifact: NonEmptyString,
  output_metrics: Schema.Array(OutputMetricDefinition),
  protocol: MeasurementProtocol,
  jobs: Schema.Array(BenchmarkJob),
}).annotate({ identifier: "BenchmarkDefinition", title: "LiteLLM benchmark definition" });

const duplicateIssues = (
  path: string,
  values: ReadonlyArray<string>,
): ReadonlyArray<ValidationIssue> => {
  const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
  return [...new Set(duplicates)].map((value) => ({ path, message: `duplicate id: ${value}` }));
};

const lookupPath = (value: JsonRecord, path: string): unknown =>
  path.split(".").reduce<unknown>((current, part) => {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    return (current as JsonRecord)[part];
  }, value);

export function validateBenchmarkDefinition(
  definition: typeof BenchmarkDefinition.Type,
): ReadonlyArray<ValidationIssue> {
  const scenarioIds = definition.protocol.scenarios.map(({ id }) => id);
  const measurementIds = definition.protocol.measurements.map(({ id }) => id);
  const scenarioSet = new Set(scenarioIds);
  const measurementSet = new Set(measurementIds);
  const analysisReferences = definition.protocol.analyses.flatMap((analysis) => [
    ...(!measurementSet.has(analysis.measurement)
      ? [{ path: `protocol.analyses.${analysis.id}.measurement`, message: "unknown measurement" }]
      : []),
    ...(analysis.additional_measurements ?? []).filter((id) => !measurementSet.has(id)).map((
      id,
    ) => ({
      path: `protocol.analyses.${analysis.id}.additional_measurements`,
      message: `unknown measurement: ${id}`,
    })),
    ...(analysis.scenarios ?? []).filter((id) => !scenarioSet.has(id)).map((id) => ({
      path: `protocol.analyses.${analysis.id}.scenarios`,
      message: `unknown scenario: ${id}`,
    })),
  ]);
  const attempts = definition.protocol.attempts;
  const attemptIssues = attempts === undefined ? [] : definition.jobs.flatMap((job) => {
    const configured = lookupPath(job.config, attempts.count_from);
    return configured === attempts.count ? [] : [{
      path: `jobs.${job.id}.config.${attempts.count_from}`,
      message: `expected protocol attempt count ${attempts.count}`,
    }];
  });
  const requirementIssues = definition.jobs.flatMap((job) => {
    if (job.requirements === undefined) return [];
    return (["python", "platform", "architecture"] as const).flatMap((key) => {
      const expected = job.requirements?.[key];
      return expected !== undefined && job.config[key] !== undefined && job.config[key] !== expected
        ? [{ path: `jobs.${job.id}.config.${key}`, message: `conflicts with requirements.${key}` }]
        : [];
    });
  });
  const canonicalJobs = definition.jobs.filter((job) => job.canonical === true);
  return [
    ...duplicateIssues("output_metrics", definition.output_metrics.map(({ id }) => id)),
    ...duplicateIssues("jobs", definition.jobs.map(({ id }) => id)),
    ...(canonicalJobs.length === 1 ? [] : [{
      path: "jobs",
      message: `expected exactly one canonical job, found ${canonicalJobs.length}`,
    }]),
    ...duplicateIssues("protocol.scenarios", scenarioIds),
    ...duplicateIssues("protocol.measurements", measurementIds),
    ...duplicateIssues("protocol.analyses", definition.protocol.analyses.map(({ id }) => id)),
    ...analysisReferences,
    ...attemptIssues,
    ...requirementIssues,
  ];
}

export type BenchmarkDefinition = typeof BenchmarkDefinition.Type;
export type BenchmarkJob = typeof BenchmarkJob.Type;
export type EnvironmentRequirements = typeof EnvironmentRequirements.Type;
export type HostEnvironmentSnapshot = typeof HostEnvironmentSnapshot.Type;
