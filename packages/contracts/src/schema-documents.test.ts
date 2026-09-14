import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { fileURLToPath } from "node:url";

import { generateSchemaDocuments } from "./schema-documents.js";

it.effect("generated JSON Schemas are current and reject unknown object fields", () =>
  Effect.gen(function*() {
    const documents = generateSchemaDocuments();
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const output = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../schemas/current",
    );
    yield* Effect.forEach(
      Object.entries(documents),
      ([name, schema]) =>
        fs.readFileString(path.resolve(output, name)).pipe(Effect.map((contents) => {
          const committed = JSON.parse(contents) as Record<string, unknown>;
          expect(committed).toEqual(schema);
          expect(committed.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
          expect(committed.$id).toBe(`https://litellm.ai/schemas/current/${name}`);
          expect(typeof committed.$defs).toBe("object");
          expect(String(committed.$ref)).toMatch(/^#\/\$defs\//);
        })),
      { concurrency: "unbounded", discard: true },
    );
  }).pipe(Effect.provide(NodeServices.layer)));
