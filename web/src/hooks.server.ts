import { dev } from "$app/environment";
import { base } from "$app/paths";
import {
  dataDirectory as resolveDataDirectory,
  readAnnotations,
  readIndex,
} from "$lib/server/benchmarks";
import { NodeServices } from "@effect/platform-node";
import type { Handle } from "@sveltejs/kit";
import { Effect, FileSystem, Path } from "effect";

const dataPath = `${base}/data/`;

export const handle: Handle = async ({ event, resolve: resolveRequest }) => {
  if (!dev || !event.url.pathname.startsWith(dataPath)) return resolveRequest(event);

  const content = await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dataDirectory = resolveDataDirectory();
      const relativePath = decodeURIComponent(event.url.pathname.slice(dataPath.length));
      if (relativePath === "index.json") {
        return `${
          JSON.stringify(yield* Effect.promise(() => readIndex(dataDirectory)), null, 2)
        }\n`;
      }
      if (relativePath === "annotations.json") {
        return JSON.stringify({
          annotations: yield* Effect.promise(() => readAnnotations(dataDirectory)),
        });
      }
      const filePath = path.resolve(dataDirectory, relativePath);
      if (!filePath.startsWith(`${dataDirectory}${path.sep}`)) return undefined;
      return yield* fs.readFileString(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  if (!content) return new Response(null, { status: 404 });
  return new Response(content, { headers: { "content-type": "application/json" } });
};
