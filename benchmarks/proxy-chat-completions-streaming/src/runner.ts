import { type BenchmarkRunner, type RunContext } from "@litellm-bench/harness";
import { measurementIssue, ProxyEnvironment, runWithRoundRetries } from "@litellm-bench/proxy";
import { Effect, Path } from "effect";
import { decodeStreamingChatRun } from "./config.js";
import { makeStreamingChatExperiment } from "./experiment.js";
import { buildStreamingChatResult, trialRetryIssue } from "./result.js";

export const makeStreamingChatCompletionsRunner: Effect.Effect<
  BenchmarkRunner,
  never,
  ProxyEnvironment | Path.Path
> = Effect.gen(function*() {
  const environment = yield* ProxyEnvironment;
  const path = yield* Path.Path;
  return {
    id: "proxy-chat-completions-streaming",
    run: Effect.fn("ProxyStreamingChat.run")(function*(context: RunContext) {
      const { config, subject } = yield* decodeStreamingChatRun(context);
      const raw = yield* runWithRoundRetries({
        run: environment.run,
        experiment: makeStreamingChatExperiment(context, config, subject.image),
        maximumAttempts: config.retry_attempts,
        issue: (trial) => measurementIssue(trialRetryIssue(trial, config)),
        metadataKey: "round_retries",
      }).pipe(Effect.provideService(Path.Path, path));
      return yield* buildStreamingChatResult(context, raw, config);
    }),
  };
});

export const runner = makeStreamingChatCompletionsRunner;
