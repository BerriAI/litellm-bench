import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import canonicalizePackage from "canonicalize";

import type { Json, JsonRecord } from "./common.js";
import type { RunSpec } from "./results.js";

const serializeCanonical = canonicalizePackage as unknown as (input: unknown) => string | undefined;

export interface CaseIdentityInput {
  readonly domain: "case";
  readonly benchmark_id: string;
  readonly output_metrics: ReadonlyArray<{
    readonly id: string;
    readonly unit: string;
    readonly better: "higher" | "lower" | "neutral";
  }>;
  readonly protocol: JsonRecord;
  readonly job: {
    readonly id: string;
    readonly config: JsonRecord;
    readonly requirements: JsonRecord | null;
  };
  readonly target: {
    readonly version: string;
    readonly artifact: JsonRecord;
  };
}

export interface ComparisonIdentityInput {
  readonly domain: "comparison";
  readonly benchmark_id: string;
  readonly output_metrics: CaseIdentityInput["output_metrics"];
  readonly protocol: JsonRecord;
  readonly job: {
    readonly id: string;
    readonly config: JsonRecord;
    readonly requirements: JsonRecord | null;
  };
}

const ensureSafeNumbers = (value: Json, path = "$identity"): void => {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError(
        `${path} contains an unsafe integer; encode exact quantities as decimal strings`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => ensureSafeNumbers(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object" && value !== null) {
    Object.entries(value).forEach(([key, item]) => ensureSafeNumbers(item, `${path}.${key}`));
  }
};

export function canonicalIdentity(value: CaseIdentityInput | ComparisonIdentityInput): string {
  return canonicalJson(value as unknown as Json);
}

export function canonicalJson(value: Json): string {
  ensureSafeNumbers(value as unknown as Json);
  const canonical = serializeCanonical(value);
  if (canonical === undefined) throw new TypeError("value is not JSON serializable");
  return canonical;
}

export function identityDigest(value: CaseIdentityInput | ComparisonIdentityInput): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalIdentity(value))));
}

const identityJob = (spec: RunSpec): CaseIdentityInput["job"] => ({
  id: spec.job.id,
  config: spec.job.config,
  requirements: spec.job.requirements ?? null,
});

const identityProtocol = (spec: RunSpec): JsonRecord => ({
  ...(spec.benchmark.protocol.experimental_unit === undefined
    ? {}
    : { experimental_unit: spec.benchmark.protocol.experimental_unit }),
  scenarios: spec.benchmark.protocol.scenarios.map(({ id, dimensions }) => ({ id, dimensions })),
  ...(spec.benchmark.protocol.attempts === undefined
    ? {}
    : { attempts: spec.benchmark.protocol.attempts }),
  measurements: spec.benchmark.protocol.measurements.map(({ id, unit, role, better }) => ({
    id,
    unit,
    role,
    ...(better === undefined ? {} : { better }),
  })),
  analyses: spec.benchmark.protocol.analyses.map(({
    id,
    measurement,
    additional_measurements,
    scenarios,
    group_by,
    pair_by,
    operation,
    aggregation,
    report,
  }) => ({
    id,
    measurement,
    ...(additional_measurements === undefined ? {} : { additional_measurements }),
    ...(scenarios === undefined ? {} : { scenarios }),
    ...(group_by === undefined ? {} : { group_by }),
    ...(pair_by === undefined ? {} : { pair_by }),
    ...(operation === undefined ? {} : { operation }),
    aggregation,
    ...(report === undefined ? {} : { report }),
  })),
  ...(spec.benchmark.protocol.validity === undefined
    ? {}
    : { validity: spec.benchmark.protocol.validity }),
  ...(spec.benchmark.protocol.variants === undefined
    ? {}
    : { variants: spec.benchmark.protocol.variants.map(({ id, settings }) => ({ id, settings })) }),
});

const identityOutputMetrics = (spec: RunSpec): CaseIdentityInput["output_metrics"] =>
  spec.benchmark.output_metrics.map(({ id, unit, better }) => ({ id, unit, better }));

export function caseIdentityInput(spec: RunSpec): CaseIdentityInput {
  return {
    domain: "case",
    benchmark_id: spec.benchmark.id,
    output_metrics: identityOutputMetrics(spec),
    protocol: identityProtocol(spec),
    job: identityJob(spec),
    target: {
      version: spec.version.version,
      artifact: spec.artifact,
    },
  };
}

export function comparisonIdentityInput(spec: RunSpec): ComparisonIdentityInput {
  return {
    domain: "comparison",
    benchmark_id: spec.benchmark.id,
    output_metrics: identityOutputMetrics(spec),
    protocol: identityProtocol(spec),
    job: identityJob(spec),
  };
}

export const caseId = (spec: RunSpec): string => identityDigest(caseIdentityInput(spec));
export const comparisonId = (spec: RunSpec): string =>
  identityDigest(comparisonIdentityInput(spec));
