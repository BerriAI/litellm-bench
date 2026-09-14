import { type ProxyRawObservation } from "@litellm-bench/contracts";
import { type BenchmarkRunner, InvalidObservation, type RunContext } from "@litellm-bench/harness";
import { ProxyEnvironment, type ProxyExperiment } from "@litellm-bench/proxy";
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

const trialKey = (trial: ProxyRawObservation["trials"][number]) =>
  `${trial.round}:${trial.scenario}:${trial.variant}`;

const retryIssue = (trial: ProxyRawObservation["trials"][number]): string | undefined => {
  const classified = classifyOcrTrial(trial);
  return classified.ok ? undefined : classified.issue;
};

export const runWithBlockRetries = Effect.fn("ProxyOcr.runWithBlockRetries")(
  function*(
    run: (experiment: ProxyExperiment) => Effect.Effect<ProxyRawObservation, unknown>,
    experiment: ProxyExperiment,
    maximumAttempts: number,
  ) {
    const path = yield* Path.Path;
    const latest = new Map<string, ProxyRawObservation["trials"][number]>();
    const expectedByRound = new Map<number, readonly string[]>();
    for (const trial of experiment.trials) {
      expectedByRound.set(trial.round, [
        ...(expectedByRound.get(trial.round) ?? []),
        trialKey(trial as ProxyRawObservation["trials"][number]),
      ]);
    }
    let pending = new Set(expectedByRound.keys());
    let metadata: ProxyRawObservation["metadata"] = {};
    const attempts: Array<{
      attempt: number;
      rounds: number[];
      failed_rounds: number[];
      reasons: string[];
    }> = [];
    for (let attempt = 1; attempt <= maximumAttempts && pending.size > 0; attempt += 1) {
      const plans = experiment.trials
        .filter(({ round }) => pending.has(round))
        .map((trial) => attempt === 1 ? trial : { ...trial, id: `${trial.id}_retry${attempt}` });
      const raw = yield* run({
        ...experiment,
        artifactsDirectory: path.join(experiment.artifactsDirectory, `attempt-${attempt}`),
        trials: plans,
      }).pipe(
        Effect.mapError((error) =>
          new InvalidObservation({
            message: error instanceof Error ? error.message : String(error),
          })
        ),
      );
      metadata = raw.metadata;
      for (const trial of raw.trials) latest.set(trialKey(trial), trial);
      const failed = new Set<number>();
      const reasons: string[] = [];
      for (const round of pending) {
        const expected = expectedByRound.get(round) ?? [];
        const rows = raw.trials.filter((trial) => trial.round === round);
        const actual = rows.map(trialKey);
        const issues = rows.flatMap((trial) => {
          const issue = retryIssue(trial);
          return issue === undefined ? [] : [`${trial.id}: ${issue}`];
        });
        if (
          actual.length !== expected.length
          || !expected.every((key) => actual.includes(key))
          || issues.length > 0
        ) {
          failed.add(round);
          reasons.push(
            ...issues,
            ...(actual.length === expected.length ? [] : [`round ${round}: incomplete block`]),
          );
        }
      }
      attempts.push({ attempt, rounds: [...pending], failed_rounds: [...failed], reasons });
      pending = failed;
    }
    const trials = experiment.trials.flatMap((trial) => {
      const found = latest.get(trialKey(trial as ProxyRawObservation["trials"][number]));
      return found === undefined ? [] : [found];
    });
    return {
      trials,
      metadata: {
        ...metadata,
        ocr_block_retries: {
          maximum_attempts: maximumAttempts,
          attempts,
          exhausted_rounds: [...pending],
        },
      },
    } satisfies ProxyRawObservation;
  },
);

export const runner = makeOcrRunner.pipe(Effect.provide(OcrArtifactsLive));
