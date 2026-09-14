import { type BenchmarkRunner, InvalidObservation, type RunContext } from "@litellm-bench/harness";
import { ProxyEnvironment } from "@litellm-bench/proxy";
import { Effect } from "effect";
import { decodeChatRun } from "./config.js";
import { makeChatExperiment } from "./experiment.js";
import { buildChatResult } from "./result.js";

export const makeChatCompletionsRunner: Effect.Effect<BenchmarkRunner, never, ProxyEnvironment> =
  Effect.gen(function*() {
    const environment = yield* ProxyEnvironment;
    return {
      id: "proxy-chat-completions",
      run: Effect.fn("ProxyChat.run")(function*(context: RunContext) {
        const { config, subject } = yield* decodeChatRun(context);
        const raw = yield* environment.run(makeChatExperiment(context, config, subject.image)).pipe(
          Effect.mapError((error) =>
            new InvalidObservation({ message: `${error.operation}: ${error.message}` })
          ),
        );
        return yield* buildChatResult(context, raw, config);
      }),
    };
  });

export const runner = makeChatCompletionsRunner;
