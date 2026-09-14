import { Effect } from "effect";

import {
  BenchmarkCatalog,
  type CatalogBenchmark,
  type CliResponder,
  CliResponse,
  errorResponse,
  ExitCode,
  successResponse,
} from "./model.js";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const respondWithEffect = <A, E, R>(
  respond: CliResponder,
  operation: Effect.Effect<A, E, R>,
  render: (value: A) => string,
): Effect.Effect<void, never, R> =>
  Effect.matchEffect(operation, {
    onFailure: (error) => respond(errorResponse(ExitCode.UsageError, `${errorMessage(error)}\n`)),
    onSuccess: (value) => respond(successResponse(render(value))),
  });

export const respondWithCatalog = (
  respond: CliResponder,
  makeResponse: (benchmarks: ReadonlyArray<CatalogBenchmark>) => CliResponse,
) => Effect.flatMap(BenchmarkCatalog, ({ benchmarks }) => respond(makeResponse(benchmarks)));
