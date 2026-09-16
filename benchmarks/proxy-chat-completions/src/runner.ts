import { type BenchmarkRunner, type RunContext } from "@litellm-bench/harness";
import { measurementIssue, ProxyEnvironment, runWithRoundRetries } from "@litellm-bench/proxy";
import { Effect, Path } from "effect";
import { decodeChatRun } from "./config.js";
import { makeChatExperiment } from "./experiment.js";
import { buildChatResult, trialRetryIssue } from "./result.js";

export const makeChatCompletionsRunner: Effect.Effect<
  BenchmarkRunner,
  never,
  ProxyEnvironment | Path.Path
> = Effect.gen(function*() {
  const environment = yield* ProxyEnvironment;
  const path = yield* Path.Path;
  return {
    id: "proxy-chat-completions",
    run: Effect.fn("ProxyChat.run")(function*(context: RunContext) {
      const { config, subject } = yield* decodeChatRun(context);
      const raw = yield* runWithRoundRetries({
        run: environment.run,
        experiment: makeChatExperiment(context, config, subject.image),
        maximumAttempts: config.retry_attempts,
        issue: (trial) => measurementIssue(trialRetryIssue(trial, config)),
        metadataKey: "round_retries",
      }).pipe(Effect.provideService(Path.Path, path));
      return yield* buildChatResult(context, raw, config);
    }),
  };
});

export const runner = makeChatCompletionsRunner;
