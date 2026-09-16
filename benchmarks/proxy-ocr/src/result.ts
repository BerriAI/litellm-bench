import { BenchmarkResult, type ProxyRawObservation } from "@litellm-bench/contracts";
import { InvalidObservation, type RunContext } from "@litellm-bench/harness";
import { Effect, Schema } from "effect";
import { OcrArtifacts } from "./artifacts.js";
import type { OcrConfig } from "./config.js";
import { decodeOcrObservation } from "./observation.js";
import { projectOcr } from "./projection.js";
import type { OcrScenario } from "./types.js";

export const buildOcrResult = Effect.fn("ProxyOcr.buildResult")(
  function*(
    context: RunContext,
    raw: ProxyRawObservation,
    scenarios: readonly OcrScenario[],
    config: Pick<OcrConfig, "rounds" | "order_seed" | "integrity">,
  ) {
    const rows = yield* Effect.forEach(
      raw.trials,
      (trial) => decodeOcrObservation(trial, config.integrity),
    );
    const projected = yield* Effect.try({
      try: () => projectOcr(rows, scenarios, config.rounds, config.integrity, config.order_seed),
      catch: (error) =>
        new InvalidObservation({ message: error instanceof Error ? error.message : String(error) }),
    });
    const artifacts = yield* OcrArtifacts;
    yield* artifacts.writeRows(context.artifactsDirectory, rows);
    return yield* Schema.decodeUnknownEffect(BenchmarkResult, { onExcessProperty: "error" })({
      run_id: context.runId,
      created_at: context.createdAt,
      case_id: context.spec.case_id,
      comparison_id: context.spec.comparison_id,
      benchmark: context.spec.benchmark,
      job: context.spec.job,
      version: context.spec.version.version,
      artifact: context.spec.artifact,
      apparatus: raw.metadata,
      metrics: projected.metrics,
      trials: projected.trials,
      analyses: projected.analyses,
      details: raw,
      status: "ok",
    }).pipe(Effect.mapError((error) => new InvalidObservation({ message: error.message })));
  },
);
