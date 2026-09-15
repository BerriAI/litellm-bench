import { Schema } from "effect";

import {
  FiniteNumber,
  JsonObject,
  NonEmptyString,
  NonNegativeInteger,
  PositiveInteger,
} from "./common.js";

export const SdkSubject = Schema.Struct({
  requirement: NonEmptyString,
  distribution: NonEmptyString,
}).annotate({ identifier: "SdkSubject" });

export const SdkRuntime = Schema.Struct({
  python: NonEmptyString,
  platform: Schema.optionalKey(NonEmptyString),
  architecture: Schema.optionalKey(NonEmptyString),
}).annotate({ identifier: "SdkRuntime" });

export const SdkWorkload = Schema.Struct({
  name: NonEmptyString,
  statement: NonEmptyString,
}).annotate({ identifier: "SdkWorkload" });

export const SdkMeasurements = Schema.Struct({
  warmups: NonNegativeInteger,
  samples: PositiveInteger,
  timing: Schema.Boolean,
  diagnostics: Schema.Boolean,
  importtime: Schema.Boolean,
  network: Schema.Boolean,
  timeout_seconds: PositiveInteger,
}).annotate({ identifier: "SdkMeasurements" });

export const SdkResolver = Schema.Struct({
  index_url: Schema.optionalKey(NonEmptyString),
  extra_index_urls: Schema.Array(NonEmptyString),
  find_links: Schema.Array(NonEmptyString),
  binary_only: Schema.Boolean,
}).annotate({ identifier: "SdkResolver" });

export const SdkBenchmarkSpec = Schema.Struct({
  subject: SdkSubject,
  runtime: SdkRuntime,
  workload: SdkWorkload,
  measurements: SdkMeasurements,
  resolver: SdkResolver,
  environment: Schema.Record(NonEmptyString, NonEmptyString),
  profile: NonEmptyString,
}).annotate({ identifier: "SdkBenchmarkSpec", title: "LiteLLM SDK benchmark specification" });

export const FreshProcessObservation = Schema.Struct({
  count: PositiveInteger,
  samples_seconds: Schema.Array(FiniteNumber),
  minimum_seconds: FiniteNumber,
  median_seconds: FiniteNumber,
  p95_seconds: FiniteNumber,
  maximum_seconds: FiniteNumber,
}).annotate({ identifier: "FreshProcessObservation" });

export const DiagnosticProbe = Schema.Struct({
  import_only_seconds: Schema.optionalKey(FiniteNumber),
  new_module_count: Schema.optionalKey(NonNegativeInteger),
  peak_rss_bytes: Schema.optionalKey(NonNegativeInteger),
  network: Schema.optionalKey(JsonObject),
  importtime: Schema.optionalKey(JsonObject),
}).annotate({ identifier: "DiagnosticProbe" });

export const ResolutionObservation = Schema.Struct({
  artifact_count: NonNegativeInteger,
  download_bytes: NonNegativeInteger,
  package_artifact_bytes: Schema.optionalKey(NonNegativeInteger),
  artifacts: Schema.Array(JsonObject),
  policy: Schema.optionalKey(NonEmptyString),
  inputs: Schema.optionalKey(JsonObject),
}).annotate({ identifier: "ResolutionObservation" });

export const DirectoryMeasurement = Schema.Struct({
  logical_bytes: NonNegativeInteger,
  allocated_bytes: Schema.optionalKey(NonNegativeInteger),
}).annotate({ identifier: "DirectoryMeasurement" });

export const SdkRawObservation = Schema.Struct({
  runtime: JsonObject,
  timing: Schema.optionalKey(Schema.Struct({
    first_ever_process_seconds: FiniteNumber,
    warmup_samples_seconds: Schema.Array(FiniteNumber),
    fresh_process: FreshProcessObservation,
  })),
  diagnostics: DiagnosticProbe,
  resolution: ResolutionObservation,
  size: Schema.Struct({
    installed_before_first_run: DirectoryMeasurement,
    installed_after_first_run: Schema.optionalKey(DirectoryMeasurement),
    first_run_logical_delta_bytes: Schema.optionalKey(Schema.Int),
    first_run_allocated_delta_bytes: Schema.optionalKey(Schema.Int),
  }),
}).annotate({ identifier: "SdkRawObservation" });

export const PythonProbeRequest = Schema.Struct({
  workload: SdkWorkload,
  output_path: NonEmptyString,
  collect_import_time: Schema.Boolean,
  collect_modules: Schema.Boolean,
  collect_peak_rss: Schema.Boolean,
  collect_network: Schema.Boolean,
}).annotate({ identifier: "PythonProbeRequest" });

export const PythonProbeResponse = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ok"),
    observation: DiagnosticProbe,
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    error: Schema.Struct({ type: NonEmptyString, message: Schema.String }),
  }),
], { mode: "oneOf" }).annotate({ identifier: "PythonProbeResponse" });

export const TimingProbeRequest = Schema.Struct({
  python: NonEmptyString,
  statement: NonEmptyString,
  timeout_seconds: PositiveInteger,
  samples: PositiveInteger,
  output_path: NonEmptyString,
}).annotate({ identifier: "TimingProbeRequest" });

export const TimingProbeResponse = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ok"),
    samples_seconds: Schema.NonEmptyArray(FiniteNumber),
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    error: Schema.Struct({
      type: NonEmptyString,
      message: Schema.String,
      sample_index: Schema.optionalKey(PositiveInteger),
    }),
    completed_samples_seconds: Schema.optionalKey(Schema.Array(FiniteNumber)),
  }),
], { mode: "oneOf" }).annotate({ identifier: "TimingProbeResponse" });

export type SdkBenchmarkSpec = typeof SdkBenchmarkSpec.Type;
export type SdkRawObservation = typeof SdkRawObservation.Type;
export type PythonProbeRequest = typeof PythonProbeRequest.Type;
export type PythonProbeResponse = typeof PythonProbeResponse.Type;
export type TimingProbeRequest = typeof TimingProbeRequest.Type;
export type TimingProbeResponse = typeof TimingProbeResponse.Type;
