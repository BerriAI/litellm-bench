import { ingest, rebuildIndex } from "@litellm-bench/result-store";
import { Array, Effect, Option, Path, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { validatePath, writeSchemas } from "./documents.js";
import {
  type CatalogBenchmark,
  type CliResponder,
  CliResponse,
  errorResponse,
  ExitCode,
  successResponse,
} from "./model.js";
import { respondWithCatalog, respondWithEffect } from "./responses.js";
import { makeRunCommand } from "./runs.js";
import { makeSmokeCommand } from "./smoke.js";
import { sourceMetadata } from "./source-metadata.js";
import { makePlanCommand, makeRunVersionCommand } from "./suite.js";

const WriteMode = Schema.Literals([
  "append",
  "replace-case-version",
  "replace-benchmark-version",
]);
const decodeWriteMode = Schema.decodeUnknownEffect(WriteMode);

const benchmarkNotFound = (benchmarkId: string): CliResponse =>
  errorResponse(ExitCode.NotFound, `Benchmark not found: ${benchmarkId}\n`);

const findBenchmark = (benchmarks: ReadonlyArray<CatalogBenchmark>, benchmarkId: string) =>
  Array.findFirst(benchmarks, ({ id }) => id === benchmarkId);

const makeListCommand = (respond: CliResponder) =>
  Command.make("list", {}, () =>
    respondWithCatalog(
      respond,
      (benchmarks) =>
        successResponse(`${benchmarks.map(({ id, label }) => `${id}\t${label}`).join("\n")}\n`),
    )).pipe(Command.withDescription("List benchmarks in the generated catalog"));

const makeDescribeCommand = (respond: CliResponder) =>
  Command.make(
    "describe",
    { benchmarkId: Argument.String("benchmark") },
    ({ benchmarkId }) =>
      respondWithCatalog(
        respond,
        (benchmarks) =>
          Option.match(findBenchmark(benchmarks, benchmarkId), {
            onNone: () => benchmarkNotFound(benchmarkId),
            onSome: (benchmark) => successResponse(`${JSON.stringify(benchmark, null, 2)}\n`),
          }),
      ),
  ).pipe(Command.withDescription("Describe a benchmark from the generated catalog"));

const makeValidateCommand = (respond: CliResponder) =>
  Command.make(
    "validate",
    { path: Argument.String("path") },
    ({ path }) => respondWithEffect(respond, validatePath(path), (kind) => `valid=${kind}\n`),
  ).pipe(Command.withDescription("Validate a current-format JSON document"));

const makeDataCommand = (respond: CliResponder) => {
  const ingestData = Command.make(
    "ingest",
    {
      input: Flag.String("input"),
      data: Flag.String("data"),
      mode: Flag.String("mode").pipe(Flag.withDefault("append")),
    },
    ({ input, data, mode }) =>
      Effect.matchEffect(decodeWriteMode(mode), {
        onFailure: () =>
          respond(errorResponse(ExitCode.UsageError, `unsupported write mode: ${mode}\n`)),
        onSuccess: (writeMode) =>
          respondWithEffect(
            respond,
            Effect.flatMap(
              sourceMetadata,
              (source) => Effect.tryPromise(() => ingest(input, data, source, writeMode)),
            ),
            (count) => `ingested=${count}\n`,
          ),
      }),
  ).pipe(Command.withDescription("Ingest validated benchmark results transactionally"));

  const indexData = Command.make(
    "index",
    { data: Flag.String("data") },
    ({ data }) =>
      respondWithEffect(
        respond,
        Effect.tryPromise(() => rebuildIndex(data)),
        (index) => `records=${index.record_count}\n`,
      ),
  ).pipe(Command.withDescription("Rebuild the current-format benchmark index"));

  return Command.make("data").pipe(
    Command.withDescription("Manage benchmark result data"),
    Command.withSubcommands([ingestData, indexData]),
  );
};

const makeSchemaCommand = (respond: CliResponder, defaultOutput: string) => {
  const generate = Command.make(
    "generate",
    { output: Flag.String("output").pipe(Flag.withDefault(defaultOutput)) },
    ({ output }) =>
      respondWithEffect(
        respond,
        writeSchemas(output, false),
        (count) => `generated=${count}\n`,
      ),
  );

  const check = Command.make(
    "check",
    { output: Flag.String("output").pipe(Flag.withDefault(defaultOutput)) },
    ({ output }) =>
      respondWithEffect(
        respond,
        writeSchemas(output, true),
        (count) => `checked=${count}\n`,
      ),
  );

  return Command.make("schema").pipe(
    Command.withDescription("Generate or verify Effect-derived JSON Schema"),
    Command.withSubcommands([generate, check]),
  );
};

export const makeCliCommand = (respond: CliResponder) =>
  Effect.map(Path.Path, (path) =>
    Command.make("litellm-bench").pipe(
      Command.withDescription("LiteLLM benchmark orchestration"),
      Command.withSubcommands([
        makeListCommand(respond),
        makeDescribeCommand(respond),
        makePlanCommand(respond),
        makeRunCommand(respond),
        makeRunVersionCommand(respond),
        makeSmokeCommand(respond),
        makeValidateCommand(respond),
        makeDataCommand(respond),
        makeSchemaCommand(respond, path.resolve("schemas/current")),
      ]),
    ));
