import { type ProxyRawObservation } from "@litellm-bench/contracts";
import { type BenchmarkRunner, type RunContext } from "@litellm-bench/harness";
import {
  ProxyEnvironment,
  type ProxyEnvironmentShape,
  type ProxyExperiment,
  type RoundIssue,
  runWithRoundRetries,
} from "@litellm-bench/proxy";
import { Effect, Path } from "effect";
import { OcrArtifacts, OcrArtifactsLive } from "./artifacts.js";
import { decodeOcrRun, type OcrIntegrity } from "./config.js";
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
        decoded.config.integrity,
      ).pipe(Effect.provideService(Path.Path, path));
      return yield* buildOcrResult(context, raw, decoded.scenarios, decoded.config).pipe(
        Effect.provideService(OcrArtifacts, artifacts),
      );
    }),
  };
});

const retryIssue = (
  trial: ProxyRawObservation["trials"][number],
  integrity: OcrIntegrity,
): RoundIssue | undefined => {
  const classified = classifyOcrTrial(trial, integrity);
  return classified.ok ? undefined : { kind: classified.kind, reason: classified.issue };
};

export const runWithBlockRetries = (
  run: ProxyEnvironmentShape["run"],
  experiment: ProxyExperiment,
  maximumAttempts: number,
  integrity: OcrIntegrity,
) =>
  runWithRoundRetries({
    run,
    experiment,
    maximumAttempts,
    issue: (trial) => retryIssue(trial, integrity),
    metadataKey: "ocr_block_retries",
  });

export const runner = makeOcrRunner.pipe(Effect.provide(OcrArtifactsLive));
