import { Schema } from "effect";

import { AnnotationDocument } from "./annotations.js";
import { BenchmarkDefinition } from "./metadata.js";
import { ProxyRawObservation, UpstreamFixture } from "./proxy.js";
import { BenchmarkIndex, BenchmarkResult, CommittedRecord, RunSpec } from "./results.js";
import {
  PythonProbeRequest,
  PythonProbeResponse,
  SdkBenchmarkSpec,
  SdkRawObservation,
  TimingProbeRequest,
  TimingProbeResponse,
} from "./sdk.js";

const definitions = {
  "annotations.schema.json": AnnotationDocument,
  "benchmark.schema.json": BenchmarkDefinition,
  "index.schema.json": BenchmarkIndex,
  "probe-request.schema.json": PythonProbeRequest,
  "probe-response.schema.json": PythonProbeResponse,
  "timing-probe-request.schema.json": TimingProbeRequest,
  "timing-probe-response.schema.json": TimingProbeResponse,
  "proxy-observation.schema.json": ProxyRawObservation,
  "record.schema.json": CommittedRecord,
  "result.schema.json": BenchmarkResult,
  "run-spec.schema.json": RunSpec,
  "sdk-observation.schema.json": SdkRawObservation,
  "sdk-spec.schema.json": SdkBenchmarkSpec,
  "upstream.schema.json": UpstreamFixture,
} as const;

export type SchemaDocumentName = keyof typeof definitions;

export function generateSchemaDocuments(): Readonly<Record<SchemaDocumentName, unknown>> {
  return Object.fromEntries(
    Object.entries(definitions).map(([name, schema]) => {
      const document = Schema.toJsonSchemaDocument(schema, {
        onExcessProperty: "error",
        generateDescriptions: true,
      });
      return [name, {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: `https://litellm.ai/schemas/current/${name}`,
        ...document.schema,
        $defs: document.definitions,
      }];
    }),
  ) as Readonly<Record<SchemaDocumentName, unknown>>;
}
