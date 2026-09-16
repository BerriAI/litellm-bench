import { expect, it } from "@effect/vitest";
import type { ProxyRawObservation } from "@litellm-bench/contracts";
import { Effect, Path } from "effect";
import type { ProxyExperiment, ProxyTrialPlan } from "./models.js";
import {
  measurementIssue,
  type ProxyRawTrial,
  type RoundIssue,
  runWithRoundRetries,
} from "./retries.js";
import { ProxyRuntimeError } from "./runtime.js";

const load = { mode: "closed", concurrency: 1, duration_seconds: 1, warmup_seconds: 0 } as const;

const plan = (round: number, variant: string): ProxyTrialPlan => ({
  id: `core_${variant}_r${round}`,
  scenario: "core",
  variant,
  round,
  load,
  workload: {
    request: { method: "GET", path: "/", headers: {} },
    response: { status: 200, jsonEquals: [] },
    body: new Uint8Array(),
  },
  proxyConfigPath: "/config.yaml",
  fixturePath: "/fixture.json",
  mockImage: "mock:test",
  dimensions: {},
});

const experiment: ProxyExperiment = {
  image: "proxy:test",
  resources: { cpus: 1, memory: "1g", workers: 1, idleSeconds: 0, logDriver: "none" },
  artifactsDirectory: "/artifacts",
  trials: [plan(1, "a"), plan(1, "b"), plan(2, "a"), plan(2, "b")],
};

const observed = (
  plans: readonly ProxyTrialPlan[],
  failing: (plan: ProxyTrialPlan) => boolean = () => false,
): ProxyRawObservation => ({
  metadata: { docker: "test" },
  trials: plans.map(({ id, scenario, variant, round }) => ({
    id,
    scenario,
    variant,
    round,
    load,
    dimensions: { attempt_id: id },
    ...(failing({ ...plan(round, variant), id }) ? { error: "boom" } : {}),
  })),
});

const issue = (trial: ProxyRawTrial) => measurementIssue(trial.error);

it.effect("probes the first round alone, then runs the rest, when every round is valid", () =>
  Effect.gen(function*() {
    const seen: ProxyExperiment[] = [];
    const raw = yield* runWithRoundRetries({
      run: (candidate) => Effect.sync(() => (seen.push(candidate), observed(candidate.trials))),
      experiment,
      maximumAttempts: 3,
      issue,
      metadataKey: "round_retries",
    });
    expect(seen.map((candidate) => candidate.artifactsDirectory)).toEqual([
      "/artifacts/probe",
      "/artifacts/attempt-1",
    ]);
    expect(seen.map((candidate) => candidate.trials.map(({ id }) => id))).toEqual([
      ["core_a_r1", "core_b_r1"],
      ["core_a_r2", "core_b_r2"],
    ]);
    expect(raw.trials.map(({ id }) => id)).toEqual(experiment.trials.map(({ id }) => id));
    expect(raw.metadata).toMatchObject({
      docker: "test",
      round_retries: {
        maximum_attempts: 3,
        probe_round: 1,
        attempts: [{ attempt: 1, rounds: [1, 2], failed_rounds: [], reasons: [] }],
        exhausted_rounds: [],
        apparatus_issues: [],
      },
    });
  }).pipe(Effect.provide(Path.layer)));

it.effect("runs a single-round experiment as one attempt without a probe", () =>
  Effect.gen(function*() {
    const seen: ProxyExperiment[] = [];
    const raw = yield* runWithRoundRetries({
      run: (candidate) => Effect.sync(() => (seen.push(candidate), observed(candidate.trials))),
      experiment: { ...experiment, trials: [plan(1, "a"), plan(1, "b")] },
      maximumAttempts: 3,
      issue,
      metadataKey: "round_retries",
    });
    expect(seen.map((candidate) => candidate.artifactsDirectory)).toEqual(["/artifacts/attempt-1"]);
    expect(raw.metadata.round_retries).toMatchObject({ probe_round: null, exhausted_rounds: [] });
  }).pipe(Effect.provide(Path.layer)));

it.effect("reruns only the failed round, as a complete block, under attempt-specific artifacts", () =>
  Effect.gen(function*() {
    const seen: ProxyExperiment[] = [];
    const raw = yield* runWithRoundRetries({
      run: (candidate) =>
        Effect.sync(() => {
          seen.push(candidate);
          return observed(
            candidate.trials,
            (trial) => seen.length === 2 && trial.round === 2 && trial.variant === "b",
          );
        }),
      experiment,
      maximumAttempts: 3,
      issue,
      metadataKey: "round_retries",
    });
    expect(seen).toHaveLength(3);
    expect(seen[2]?.artifactsDirectory).toBe("/artifacts/attempt-2");
    expect(seen[2]?.trials.map(({ id }) => id)).toEqual(["core_a_r2_retry2", "core_b_r2_retry2"]);
    // Round 1 keeps its first-attempt trials; round 2 is replaced wholesale, never mixed.
    expect(raw.trials.map((trial) => trial.dimensions.attempt_id)).toEqual([
      "core_a_r1",
      "core_b_r1",
      "core_a_r2_retry2",
      "core_b_r2_retry2",
    ]);
    expect(raw.trials.every((trial) => trial.error === undefined)).toBe(true);
    expect(raw.metadata.round_retries).toEqual({
      maximum_attempts: 3,
      probe_round: 1,
      attempts: [
        { attempt: 1, rounds: [1, 2], failed_rounds: [2], reasons: ["core_b_r2: boom"] },
        { attempt: 2, rounds: [2], failed_rounds: [], reasons: [] },
      ],
      exhausted_rounds: [],
      apparatus_issues: [],
    });
  }).pipe(Effect.provide(Path.layer)));

it.effect("treats a missing trial as an incomplete round and retries it", () =>
  Effect.gen(function*() {
    let runs = 0;
    const raw = yield* runWithRoundRetries({
      run: (candidate) =>
        Effect.sync(() => {
          runs += 1;
          const full = observed(candidate.trials);
          return runs === 1
            ? { ...full, trials: full.trials.filter(({ id }) => id !== "core_a_r1") }
            : full;
        }),
      experiment,
      maximumAttempts: 2,
      issue,
      metadataKey: "round_retries",
    });
    expect(runs).toBe(3);
    expect(raw.trials).toHaveLength(4);
    expect(raw.metadata.round_retries).toMatchObject({
      attempts: [
        { attempt: 1, failed_rounds: [1], reasons: ["round 1: incomplete block"] },
        { attempt: 2, rounds: [1], failed_rounds: [] },
      ],
      exhausted_rounds: [],
    });
  }).pipe(Effect.provide(Path.layer)));

it.effect("keeps the last failed evidence and reports exhausted rounds after the final attempt", () =>
  Effect.gen(function*() {
    let runs = 0;
    const raw = yield* runWithRoundRetries({
      run: (candidate) =>
        Effect.sync(() => {
          runs += 1;
          return observed(candidate.trials, (trial) => trial.round === 1);
        }),
      experiment,
      maximumAttempts: 2,
      issue,
      metadataKey: "round_retries",
    });
    expect(runs).toBe(3);
    const failed = raw.trials.filter((trial) => trial.error !== undefined);
    expect(failed.map((trial) => trial.dimensions.attempt_id)).toEqual([
      "core_a_r1_retry2",
      "core_b_r1_retry2",
    ]);
    expect(raw.metadata.round_retries).toMatchObject({
      maximum_attempts: 2,
      exhausted_rounds: [1],
    });
  }).pipe(Effect.provide(Path.layer)));

it.effect("halts after the probe when it reports an apparatus issue", () =>
  Effect.gen(function*() {
    const seen: ProxyExperiment[] = [];
    const raw = yield* runWithRoundRetries({
      run: (candidate) => Effect.sync(() => (seen.push(candidate), observed(candidate.trials))),
      experiment,
      maximumAttempts: 3,
      issue: (trial): RoundIssue | undefined =>
        trial.variant === "b" ? { kind: "apparatus", reason: "mock may be limiting" } : undefined,
      metadataKey: "round_retries",
    });
    expect(seen.map((candidate) => candidate.artifactsDirectory)).toEqual(["/artifacts/probe"]);
    expect(raw.trials.map(({ id }) => id)).toEqual(["core_a_r1", "core_b_r1"]);
    expect(raw.metadata.round_retries).toEqual({
      maximum_attempts: 3,
      probe_round: 1,
      attempts: [
        {
          attempt: 1,
          rounds: [1],
          failed_rounds: [1],
          reasons: ["core_b_r1: mock may be limiting"],
        },
      ],
      exhausted_rounds: [1],
      apparatus_issues: ["core_b_r1: mock may be limiting"],
    });
  }).pipe(Effect.provide(Path.layer)));

it.effect("stops retrying once a later round reports an apparatus issue", () =>
  Effect.gen(function*() {
    const seen: ProxyExperiment[] = [];
    const raw = yield* runWithRoundRetries({
      run: (candidate) =>
        Effect.sync(() => {
          seen.push(candidate);
          return observed(candidate.trials, (trial) => trial.round === 2);
        }),
      experiment,
      maximumAttempts: 3,
      issue: (trial): RoundIssue | undefined =>
        trial.error === undefined ? undefined : { kind: "apparatus", reason: trial.error },
      metadataKey: "round_retries",
    });
    expect(seen.map((candidate) => candidate.artifactsDirectory)).toEqual([
      "/artifacts/probe",
      "/artifacts/attempt-1",
    ]);
    expect(raw.trials).toHaveLength(4);
    expect(raw.metadata.round_retries).toMatchObject({
      attempts: [{ attempt: 1, rounds: [1, 2], failed_rounds: [2] }],
      exhausted_rounds: [2],
      apparatus_issues: ["core_a_r2: boom", "core_b_r2: boom"],
    });
  }).pipe(Effect.provide(Path.layer)));

it.effect("fails closed on runtime errors instead of retrying them", () =>
  Effect.gen(function*() {
    let attempts = 0;
    const error = yield* Effect.flip(runWithRoundRetries({
      run: () =>
        Effect.sync(() => {
          attempts += 1;
        }).pipe(
          Effect.andThen(
            Effect.fail(new ProxyRuntimeError({ operation: "start proxy", message: "not ready" })),
          ),
        ),
      experiment,
      maximumAttempts: 3,
      issue,
      metadataKey: "round_retries",
    }));
    expect(attempts).toBe(1);
    expect(error).toMatchObject({
      _tag: "RunnerExecutionError",
      message: "start proxy: not ready",
    });
  }).pipe(Effect.provide(Path.layer)));
