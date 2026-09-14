import { makeStreamingChatExperiment } from "@litellm-bench/benchmark-proxy-chat-completions-streaming/experiment";
import { makeChatExperiment } from "@litellm-bench/benchmark-proxy-chat-completions/experiment";
import { makeOcrExperiment } from "@litellm-bench/benchmark-proxy-ocr/experiment";
import type { RunContext } from "@litellm-bench/harness";
import { ProxyEnvironment, proxyTrialIssue } from "@litellm-bench/proxy";
import { Effect, Path } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { CliResponder } from "./model.js";
import { respondWithEffect } from "./responses.js";

const mockImage =
  "node:24.8.0-slim@sha256:cadbfafeb6baf87eaaffa40b3640209c4b7fd38cebde65059d15bc39cd636b85";
const context = (artifactsDirectory: string): RunContext => ({
  runId: "local-smoke",
  createdAt: new Date().toISOString(),
  artifactsDirectory,
  spec: { comparison_id: "local-smoke" } as RunContext["spec"],
});

export const runLocalSmoke = (image: string, output: string) =>
  Effect.gen(function*() {
    const environment = yield* ProxyEnvironment;
    const path = yield* Path.Path;
    const baseResources = {
      cpus: 1,
      memory: "1g",
      workers: 1,
      idle_seconds: 0,
      log_driver: "none",
      mock_cpus: 1,
      mock_memory: "256m",
    };
    const chatConfig = {
      rounds: 1,
      arrival_rates: [1],
      duration_seconds: 1,
      warmup_seconds: 0,
      preallocated_vus: 1,
      max_vus: 2,
      calibration_rate_multiplier: 2,
      mock_image: mockImage,
      resources: baseResources,
    };
    const ocrConfig = {
      cpus: 1,
      memory: "1g",
      workers: 1,
      idle_seconds: 0,
      log_driver: "none",
      mock_cpus: 1,
      mock_memory: "256m",
      mock_image: mockImage,
      rounds: 1,
      retry_attempts: 1,
      order_seed: "local-smoke",
      warmup_seconds: 0,
      duration_seconds: 1,
    };
    const experiments = [
      makeChatExperiment(context(path.join(output, "chat")), chatConfig, image),
      makeStreamingChatExperiment(context(path.join(output, "streaming")), chatConfig, image),
      makeOcrExperiment(context(path.join(output, "ocr")), ocrConfig, [{
        id: "1k",
        label: "1 KiB",
        payload_bytes: 1_024,
        concurrency: 1,
        load_model: "closed-loop",
      }], image),
    ];
    let trials = 0;
    for (const experiment of experiments) {
      const raw = yield* environment.run(experiment);
      for (const trial of raw.trials) {
        const issue = proxyTrialIssue(trial);
        if (issue !== undefined) return yield* Effect.fail(new Error(`${trial.id}: ${issue}`));
        trials += 1;
      }
    }
    return trials;
  });

export const makeSmokeCommand = (respond: CliResponder) =>
  Command.make("smoke", {
    image: Flag.String("image"),
    output: Flag.String("output").pipe(Flag.withDefault("artifacts/smoke")),
  }, ({ image, output }) =>
    respondWithEffect(respond, runLocalSmoke(image, output), (trials) =>
      `smoke=passed trials=${trials} artifacts=${output}\n`)).pipe(
      Command.withDescription("Run local chat, streaming, and OCR smoke checks"),
    );
