import type { ProxyRawObservation } from "@litellm-bench/contracts";
import { Effect, Path } from "effect";
import { toRunnerExecutionError } from "./errors.js";
import type { ProxyExperiment } from "./models.js";
import type { ProxyEnvironmentShape } from "./runtime.js";

export type ProxyRawTrial = ProxyRawObservation["trials"][number];

/**
 * Why a trial invalidates its round. `measurement` issues are transient and earn the round a
 * rerun on fresh containers; `apparatus` issues mean the benchmark's own resources are
 * misallocated, which no rerun can fix, so the run halts and reports them instead.
 */
export type RoundIssue = {
  readonly kind: "measurement" | "apparatus";
  readonly reason: string;
};

export const measurementIssue = (reason: string | undefined): RoundIssue | undefined =>
  reason === undefined ? undefined : { kind: "measurement", reason };

export type RoundRetryAttempt = {
  readonly attempt: number;
  readonly rounds: readonly number[];
  readonly failed_rounds: readonly number[];
  readonly reasons: readonly string[];
};

export type RoundRetrySummary = {
  readonly maximum_attempts: number;
  readonly probe_round: number | null;
  readonly attempts: readonly RoundRetryAttempt[];
  readonly exhausted_rounds: readonly number[];
  readonly apparatus_issues: readonly string[];
};

export interface RoundRetryOptions {
  readonly run: ProxyEnvironmentShape["run"];
  readonly experiment: ProxyExperiment;
  readonly maximumAttempts: number;
  /** Returns why a trial invalidates its round, or `undefined` when it counts as evidence. */
  readonly issue: (trial: ProxyRawTrial) => RoundIssue | undefined;
  readonly metadataKey: string;
}

const trialKey = (trial: Pick<ProxyRawTrial, "round" | "scenario" | "variant">) =>
  `${trial.round}:${trial.scenario}:${trial.variant}`;

type Phase = {
  readonly directory: string;
  readonly rounds: ReadonlySet<number>;
};

/**
 * Runs an experiment one complete round at a time, re-running every trial of a round whenever any
 * trial in it lacks measurement integrity. Rounds are the experimental unit, so a retry always
 * replaces the whole block on fresh containers; the earlier attempt stays on disk under
 * `attempt-N/` and its reasons are recorded in the returned metadata.
 *
 * The first attempt runs its first round alone, under `probe/`, before the remaining rounds so a
 * misallocated apparatus is reported after one round instead of after the whole matrix. Apparatus
 * issues are never retried: the run halts after the phase that observed them.
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
    const allRounds = [...expectedByRound.keys()].sort((a, b) => a - b);
    const probeRound = allRounds.length > 1 ? allRounds[0]! : null;
    let pending = new Set(allRounds);
    let metadata: ProxyRawObservation["metadata"] = {};
    const attempts: RoundRetryAttempt[] = [];
    const apparatusIssues: string[] = [];
    for (let attempt = 1; attempt <= maximumAttempts && pending.size > 0; attempt += 1) {
      const phases: readonly Phase[] = attempt === 1 && probeRound !== null
        ? [
          { directory: "probe", rounds: new Set([probeRound]) },
          {
            directory: `attempt-${attempt}`,
            rounds: new Set([...pending].filter((round) => round !== probeRound)),
          },
        ]
        : [{ directory: `attempt-${attempt}`, rounds: pending }];
      const ran: number[] = [];
      const failed = new Set<number>();
      const reasons: string[] = [];
      for (const phase of phases) {
        const plans = experiment.trials
          .filter(({ round }) => phase.rounds.has(round))
          .map((trial) => attempt === 1 ? trial : { ...trial, id: `${trial.id}_retry${attempt}` });
        yield* Effect.logInfo("proxy round attempt started").pipe(Effect.annotateLogs({
          attempt,
          maximum_attempts: maximumAttempts,
          phase: phase.directory,
          rounds: [...phase.rounds].join(","),
          trials: plans.length,
        }));
        const raw = yield* run({
          ...experiment,
          artifactsDirectory: path.join(experiment.artifactsDirectory, phase.directory),
          trials: plans,
        }).pipe(Effect.mapError(toRunnerExecutionError));
        metadata = raw.metadata;
        for (const trial of raw.trials) latest.set(trialKey(trial), trial);
        const phaseApparatusIssues: string[] = [];
        for (const round of phase.rounds) {
          ran.push(round);
          const expected = expectedByRound.get(round) ?? [];
          const rows = raw.trials.filter((trial) => trial.round === round);
          const actual = rows.map(trialKey);
          const issues = rows.flatMap((trial) => {
            const found = issue(trial);
            if (found === undefined) return [];
            const text = `${trial.id}: ${found.reason}`;
            if (found.kind === "apparatus") phaseApparatusIssues.push(text);
            return [text];
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
        if (phaseApparatusIssues.length > 0) {
          apparatusIssues.push(...phaseApparatusIssues);
          yield* Effect.logError("proxy apparatus lacks integrity; not retrying").pipe(
            Effect.annotateLogs({
              attempt,
              phase: phase.directory,
              failed_rounds: [...failed].join(","),
              reasons: phaseApparatusIssues.join("; "),
            }),
          );
          break;
        }
      }
      attempts.push({ attempt, rounds: ran, failed_rounds: [...failed], reasons });
      if (apparatusIssues.length > 0) {
        pending = failed;
        break;
      }
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
      probe_round: probeRound,
      attempts,
      exhausted_rounds: [...pending],
      apparatus_issues: apparatusIssues,
    };
    return {
      trials,
      metadata: { ...metadata, [metadataKey]: summary },
    } satisfies ProxyRawObservation;
  },
);
