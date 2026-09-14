import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Path } from "effect";
import { fileURLToPath } from "node:url";

import { generateSchemaDocuments } from "./schema-documents.js";

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const output = path.resolve(here, "../../../schemas/current");
  yield* fs.makeDirectory(output, { recursive: true });
  yield* Effect.forEach(
    Object.entries(generateSchemaDocuments()),
    ([name, schema]) =>
      fs.writeFileString(path.resolve(output, name), `${JSON.stringify(schema, null, 2)}\n`),
    { concurrency: "unbounded", discard: true },
  );
}).pipe(Effect.provide(NodeServices.layer));

NodeRuntime.runMain(program);
