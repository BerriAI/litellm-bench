#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { runner as chatCompletionsRunner } from "@litellm-bench/benchmark-proxy-chat-completions";
import { runner as streamingChatCompletionsRunner } from "@litellm-bench/benchmark-proxy-chat-completions-streaming";
import { runner as ocrRunner } from "@litellm-bench/benchmark-proxy-ocr";
import { runner as importFootprintRunner } from "@litellm-bench/benchmark-sdk-import-footprint";
import { runner as importTimeRunner } from "@litellm-bench/benchmark-sdk-import-time";
import { runner as packageSizeRunner } from "@litellm-bench/benchmark-sdk-package-size";
import { benchmarkCatalog } from "@litellm-bench/catalog";
import {
  ProcessExecutorLive,
  RunMetadataGeneratorLive,
  runnerRegistryLayer,
} from "@litellm-bench/harness";
import { DockerEngineLive, K6Live, ProxyEnvironmentLive } from "@litellm-bench/proxy";
import { PythonEnvironmentLive } from "@litellm-bench/python-environment";
import { Data, Effect, Layer, Runtime, Stdio, Stream } from "effect";
import { type CatalogBenchmark, catalogLayer, ExitCode, runCli } from "./main.js";

class CliExit extends Data.TaggedError("CliExit")<{
  readonly code: ExitCode;
}> {
  override readonly [Runtime.errorExitCode]: number = this.code;
  override readonly [Runtime.errorReported]: boolean = false;
}

const catalog: ReadonlyArray<CatalogBenchmark> = Object.entries(benchmarkCatalog).map(
  ([id, entry]) => ({ id, ...entry }),
);

const runnerDependencies = Layer.mergeAll(
  PythonEnvironmentLive.pipe(Layer.provideMerge(ProcessExecutorLive)),
  ProxyEnvironmentLive.pipe(Layer.provide(Layer.mergeAll(
    DockerEngineLive.pipe(Layer.provide(ProcessExecutorLive)),
    K6Live.pipe(Layer.provide(ProcessExecutorLive)),
  ))),
);
const runners = runnerRegistryLayer(Effect.all([
  chatCompletionsRunner,
  streamingChatCompletionsRunner,
  ocrRunner,
  importFootprintRunner,
  importTimeRunner,
  packageSizeRunner,
])).pipe(
  Layer.provide(runnerDependencies),
  Layer.provide(NodeServices.layer),
);

const program = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio;
  const args = yield* stdio.args;
  const response = yield* runCli(args);
  yield* Effect.all([
    Stream.make(response.stdout).pipe(Stream.run(stdio.stdout())),
    Stream.make(response.stderr).pipe(Stream.run(stdio.stderr())),
  ], { concurrency: "unbounded", discard: true });
  if (response.exitCode !== ExitCode.Success) {
    return yield* new CliExit({ code: response.exitCode });
  }
}).pipe(
  Effect.provide(Layer.mergeAll(
    NodeServices.layer,
    catalogLayer(catalog),
    runners,
    RunMetadataGeneratorLive,
  )),
);

NodeRuntime.runMain(program);
