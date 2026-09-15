import type { ProxyRawObservation } from "@litellm-bench/contracts";
import { Effect, Path } from "effect";
import { toRunnerExecutionError } from "./errors.js";
import type { ProxyExperiment } from "./models.js";
import type { ProxyEnvironmentShape } from "./runtime.js";

export type ProxyRawTrial = ProxyRawObservation["trials"][number];

export type RoundRetryAttempt = {
  readonly attempt: number;
  readonly rounds: readonly number[];
  readonly failed_rounds: readonly number[];
  readonly reasons: readonly string[];
};

export type RoundRetrySummary = {
  readonly maximum_attempts: number;
  readonly attempts: readonly RoundRetryAttempt[];
  readonly exhausted_rounds: readonly number[];
};

export interface RoundRetryOptions {
  readonly run: ProxyEnvironmentShape["run"];
  readonly experiment: ProxyExperiment;
  readonly maximumAttempts: number;
  /** Returns why a trial invalidates its round, or `undefined` when it counts as evidence. */
  readonly issue: (trial: ProxyRawTrial) => string | undefined;
  readonly metadataKey: string;
}

const trialKey = (trial: Pick<ProxyRawTrial, "round" | "scenario" | "variant">) =>
  `${trial.round}:${trial.scenario}:${trial.variant}`;

/**
 * Runs an experiment one complete round at a time, re-running every trial of a round whenever any
 * trial in it lacks measurement integrity. Rounds are the experimental unit, so a retry always
 * replaces the whole block on fresh containers; the earlier attempt stays on disk under
 * `attempt-N/` and its reasons are recorded in the returned metadata.
 */
export const runWithRoundRetries = Effect.fn("Proxy.runWithRoundRetries")(
  function*({ run, experiment, maximumAttempts, issue, metadataKey }: RoundRetryOptions) {
    const path = yield* Path.Path;
    const latest = new Map<string, ProxyRawTrial>();
    const expectedByRound = new Map<number, readonly string[]>();
    for (const trial of experiment.trials) {
      expectedByRound.set(trial.round, [
        ...(expectedByRound.get(trial.round) ?? []),
        trialKey(trial),
      ]);
    }
    let pending = new Set(expectedByRound.keys());
    let metadata: ProxyRawObservation["metadata"] = {};
    const attempts: RoundRetryAttempt[] = [];
    for (let attempt = 1; attempt <= maximumAttempts && pending.size > 0; attempt += 1) {
      const plans = experiment.trials
        .filter(({ round }) => pending.has(round))
        .map((trial) => attempt === 1 ? trial : { ...trial, id: `${trial.id}_retry${attempt}` });
      yield* Effect.logInfo("proxy round attempt started").pipe(Effect.annotateLogs({
        attempt,
        maximum_attempts: maximumAttempts,
        rounds: [...pending].join(","),
        trials: plans.length,
      }));
      const raw = yield* run({
        ...experiment,
        artifactsDirectory: path.join(experiment.artifactsDirectory, `attempt-${attempt}`),
        trials: plans,
      }).pipe(Effect.mapError(toRunnerExecutionError));
      metadata = raw.metadata;
      for (const trial of raw.trials) latest.set(trialKey(trial), trial);
      const failed = new Set<number>();
      const reasons: string[] = [];
      for (const round of pending) {
        const expected = expectedByRound.get(round) ?? [];
        const rows = raw.trials.filter((trial) => trial.round === round);
        const actual = rows.map(trialKey);
        const issues = rows.flatMap((trial) => {
          const found = issue(trial);
          return found === undefined ? [] : [`${trial.id}: ${found}`];
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
      if (failed.size > 0) {
        yield* Effect.logWarning("proxy rounds lacked measurement integrity").pipe(
          Effect.annotateLogs({
            attempt,
            failed_rounds: [...failed].join(","),
            reasons: reasons.join("; "),
            ...(attempt < maximumAttempts ? {} : { exhausted: true }),
          }),
        );
      }
      pending = failed;
    }
    const trials = experiment.trials.flatMap((trial) => {
      const found = latest.get(trialKey(trial));
      return found === undefined ? [] : [found];
    });
    const summary: RoundRetrySummary = {
      maximum_attempts: maximumAttempts,
      attempts,
      exhausted_rounds: [...pending],
    };
    return {
      trials,
      metadata: { ...metadata, [metadataKey]: summary },
    } satisfies ProxyRawObservation;
  },
);
