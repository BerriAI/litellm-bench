import { type BenchmarkRunner, type RunContext } from "@litellm-bench/harness";
import { ProxyEnvironment, toRunnerExecutionError } from "@litellm-bench/proxy";
import { Effect } from "effect";
import { decodeStreamingChatRun } from "./config.js";
import { makeStreamingChatExperiment } from "./experiment.js";
import { buildStreamingChatResult } from "./result.js";

export const makeStreamingChatCompletionsRunner: Effect.Effect<
  BenchmarkRunner,
  never,
  ProxyEnvironment
> = Effect.gen(function*() {
  const environment = yield* ProxyEnvironment;
  return {
    id: "proxy-chat-completions-streaming",
    run: Effect.fn("ProxyStreamingChat.run")(function*(context: RunContext) {
      const { config, subject } = yield* decodeStreamingChatRun(context);
      const raw = yield* environment.run(
        makeStreamingChatExperiment(context, config, subject.image),
      ).pipe(
        Effect.mapError(toRunnerExecutionError),
      );
      return yield* buildStreamingChatResult(context, raw, config);
    }),
  };
});

export const runner = makeStreamingChatCompletionsRunner;
