import { type ProxyRawObservation } from "@litellm-bench/contracts";
import { type BenchmarkRunner, type RunContext } from "@litellm-bench/harness";
import {
  ProxyEnvironment,
  type ProxyEnvironmentShape,
  type ProxyExperiment,
  runWithRoundRetries,
} from "@litellm-bench/proxy";
import { Effect, Path } from "effect";
import { OcrArtifacts, OcrArtifactsLive } from "./artifacts.js";
import { decodeOcrRun } from "./config.js";
import { makeOcrExperiment } from "./experiment.js";
import { classifyOcrTrial } from "./observation.js";
import { buildOcrResult } from "./result.js";

export const makeOcrRunner: Effect.Effect<
  BenchmarkRunner,
  never,
  ProxyEnvironment | OcrArtifacts | Path.Path
> = Effect.gen(function*() {
  const environment = yield* ProxyEnvironment;
  const artifacts = yield* OcrArtifacts;
  const path = yield* Path.Path;
  return {
    id: "proxy-ocr",
    run: Effect.fn("ProxyOcr.run")(function*(context: RunContext) {
      const decoded = yield* decodeOcrRun(context);
      const experiment = makeOcrExperiment(
        context,
        decoded.config,
        decoded.scenarios,
        decoded.subject.image,
      );
      const raw = yield* runWithBlockRetries(
        environment.run,
        experiment,
        decoded.config.retry_attempts,
      ).pipe(Effect.provideService(Path.Path, path));
      return yield* buildOcrResult(
        context,
        raw,
        decoded.scenarios,
        decoded.config.rounds,
        decoded.config.order_seed,
      ).pipe(Effect.provideService(OcrArtifacts, artifacts));
    }),
  };
});

const retryIssue = (trial: ProxyRawObservation["trials"][number]): string | undefined => {
  const classified = classifyOcrTrial(trial);
  return classified.ok ? undefined : classified.issue;
};

export const runWithBlockRetries = (
  run: ProxyEnvironmentShape["run"],
  experiment: ProxyExperiment,
  maximumAttempts: number,
) =>
  runWithRoundRetries({
    run,
    experiment,
    maximumAttempts,
    issue: retryIssue,
    metadataKey: "ocr_block_retries",
  });

export const runner = makeOcrRunner.pipe(Effect.provide(OcrArtifactsLive));
