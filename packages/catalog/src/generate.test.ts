import { fileURLToPath } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Path } from "effect";

import { renderCatalog } from "./generate.js";

it.effect("decodes and semantically validates all six workspace benchmark definitions", () =>
  Effect.gen(function*() {
    const path = yield* Path.Path;
    const packageDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const source = yield* renderCatalog(path.join(packageDirectory, "..", "..", "benchmarks"));
    const ids = [
      "proxy-chat-completions",
      "proxy-chat-completions-streaming",
      "proxy-ocr",
      "sdk-import-footprint",
      "sdk-import-time",
      "sdk-package-size",
    ];
    expect(ids.filter((id) => source.includes(`\"${id}\"`))).toHaveLength(6);
    expect(source.match(/"canonicalJob":/g)).toHaveLength(6);
  }).pipe(Effect.provide(NodeServices.layer)));
