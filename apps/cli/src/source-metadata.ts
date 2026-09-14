import { JsonObject } from "@litellm-bench/contracts";
import { Config, Effect, Option, Record, Schema } from "effect";

const SourceMetadata = Schema.Struct({
  provider: Schema.Literals(["github-actions", "local"]),
  repository: Schema.optionalKey(Schema.NonEmptyString),
  workflow: Schema.optionalKey(Schema.NonEmptyString),
  workflow_run_id: Schema.optionalKey(Schema.NonEmptyString),
  commit: Schema.optionalKey(Schema.NonEmptyString),
  ref: Schema.optionalKey(Schema.NonEmptyString),
  note: Schema.optionalKey(Schema.NonEmptyString),
});

const decodeSourceMetadata = Schema.decodeUnknownEffect(SourceMetadata, {
  onExcessProperty: "error",
});

const sourceConfig = Config.all({
  githubActions: Config.option(Config.NonEmptyString("GITHUB_ACTIONS")),
  repository: Config.option(Config.NonEmptyString("GITHUB_REPOSITORY")),
  workflow: Config.option(Config.NonEmptyString("GITHUB_WORKFLOW")),
  workflow_run_id: Config.option(Config.NonEmptyString("GITHUB_RUN_ID")),
  commit: Config.option(Config.NonEmptyString("GITHUB_SHA")),
  ref: Config.option(Config.NonEmptyString("GITHUB_REF")),
  note: Config.option(Config.NonEmptyString("BENCHMARK_RUN_NOTE")),
});

export const sourceMetadata: Effect.Effect<
  typeof JsonObject.Type,
  Config.ConfigError | Schema.SchemaError
> = Effect.gen(function*() {
  const { githubActions, ...optional } = yield* sourceConfig;
  return yield* decodeSourceMetadata({
    provider: Option.isSome(githubActions) ? "github-actions" : "local",
    ...Record.getSomes(optional),
  });
});
