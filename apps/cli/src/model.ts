import { BenchmarkDefinition, JsonObject } from "@litellm-bench/contracts";
import { Context, Data, Effect, Layer, Schema } from "effect";

export const ExitCode = {
  Success: 0,
  InternalError: 1,
  UsageError: 2,
  NotFound: 3,
} as const;

export const ExitCodeSchema = Schema.Literals([
  ExitCode.Success,
  ExitCode.InternalError,
  ExitCode.UsageError,
  ExitCode.NotFound,
]);

export type ExitCode = typeof ExitCodeSchema.Type;

export const CatalogMetric = Schema.Struct({
  unit: Schema.String,
  better: Schema.Literals(["higher", "lower", "neutral"]),
});

export type CatalogMetric = typeof CatalogMetric.Type;

export const CatalogJob = Schema.Struct({
  id: Schema.NonEmptyString,
  runner: Schema.NonEmptyString,
  config: JsonObject,
});

export type CatalogJob = typeof CatalogJob.Type;

export const CatalogBenchmark = Schema.Struct({
  id: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  kind: Schema.NonEmptyString,
  artifact: Schema.NonEmptyString,
  canonicalJob: Schema.NonEmptyString,
  canonicalRunner: Schema.NonEmptyString,
  metrics: Schema.Record(Schema.String, CatalogMetric),
  definition: BenchmarkDefinition,
});

export type CatalogBenchmark = typeof CatalogBenchmark.Type;

export interface BenchmarkCatalogShape {
  readonly benchmarks: ReadonlyArray<CatalogBenchmark>;
}

export class BenchmarkCatalog extends Context.Service<BenchmarkCatalog, BenchmarkCatalogShape>()(
  "@litellm-bench/cli/BenchmarkCatalog",
) {}

export const catalogLayer = (benchmarks: ReadonlyArray<CatalogBenchmark>) =>
  Layer.succeed(BenchmarkCatalog, { benchmarks });

export class CliResponse extends Data.Class<{
  readonly exitCode: ExitCode;
  readonly stdout: string;
  readonly stderr: string;
}> {}

export type CliResponder = (response: CliResponse) => Effect.Effect<void>;

export const successResponse = (stdout: string): CliResponse =>
  new CliResponse({ exitCode: ExitCode.Success, stdout, stderr: "" });

export const errorResponse = (exitCode: ExitCode, stderr: string): CliResponse =>
  new CliResponse({ exitCode, stdout: "", stderr });
