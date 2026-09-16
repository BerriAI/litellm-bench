import { InvalidRunnerConfig, type RunContext } from "@litellm-bench/harness";
import { Effect, Schema } from "effect";
import type { OcrScenario } from "./types.js";

const Percent = Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

/**
 * Apparatus gates a trial must satisfy before it counts as evidence. They fail closed against an
 * upstream validator or load-generator bottleneck being published as a proxy result, and a trial
 * that misses one reports an apparatus (never a measurement) issue.
 */
export const OcrIntegrity = Schema.Struct({
  proxy_cpu_min_percent: Percent,
  mock_cpu_max_percent: Percent,
  load_generator_cpu_max_percent: Percent,
});

export type OcrIntegrity = typeof OcrIntegrity.Type;

export const OcrConfig = Schema.Struct({
  cpus: Schema.Finite.pipe(Schema.check(Schema.isGreaterThan(0))),
  proxy_cpu_set: Schema.NonEmptyString,
  mock_cpu_set: Schema.NonEmptyString,
  load_generator_cpu_set: Schema.NonEmptyString,
  mock_cpus: Schema.Finite.pipe(Schema.check(Schema.isGreaterThan(0))),
  memory: Schema.NonEmptyString,
  mock_memory: Schema.NonEmptyString,
  workers: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  mock_image: Schema.NonEmptyString.pipe(
    Schema.check(Schema.isPattern(/@sha256:[a-f0-9]{64}$/)),
  ),
  rounds: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  retry_attempts: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  order_seed: Schema.NonEmptyString,
  warmup_seconds: Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  duration_seconds: Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  idle_seconds: Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  log_driver: Schema.NonEmptyString,
  integrity: OcrIntegrity,
});

export type OcrConfig = typeof OcrConfig.Type;

const Scenario = Schema.Struct({
  id: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  dimensions: Schema.Struct({
    payload_bytes: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
    concurrency: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
    load_model: Schema.Literal("closed-loop"),
  }),
});
const ProxySubject = Schema.Struct({ image: Schema.NonEmptyString });

export const decodeOcrRun = Effect.fn("ProxyOcr.decodeConfig")(function*(context: RunContext) {
  const decoded = yield* Effect.all({
    config: Schema.decodeUnknownEffect(OcrConfig, { onExcessProperty: "error" })(
      context.spec.job.config,
    ),
    scenarios: Schema.decodeUnknownEffect(Schema.NonEmptyArray(Scenario), {
      onExcessProperty: "error",
    })(context.spec.benchmark.protocol.scenarios),
    subject: Schema.decodeUnknownEffect(ProxySubject, { onExcessProperty: "error" })(
      context.spec.artifact,
    ),
  }).pipe(Effect.mapError((error) => new InvalidRunnerConfig({ message: error.message })));
  const duplicate = decoded.scenarios.find(({ id }, index) =>
    decoded.scenarios.findIndex((scenario) => scenario.id === id) !== index
  );
  if (duplicate !== undefined) {
    return yield* new InvalidRunnerConfig({ message: `Duplicate OCR scenario: ${duplicate.id}` });
  }
  const scenarios: readonly OcrScenario[] = decoded.scenarios.map(({ dimensions, id, label }) => ({
    id,
    label,
    payload_bytes: dimensions.payload_bytes,
    concurrency: dimensions.concurrency,
    load_model: dimensions.load_model,
  }));
  return { config: decoded.config, scenarios, subject: decoded.subject };
});
