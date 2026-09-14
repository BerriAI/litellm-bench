import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Effect, FileSystem } from "effect";
import { createMockServer, decodePngExpectations, FixtureError } from "./server.js";

const main = Effect.gen(function*() {
  const path = yield* Config.String("MOCK_FIXTURE");
  const port = yield* Config.Int("MOCK_PORT").pipe(Config.withDefault(8080));
  const rawPngExpectations = yield* Config.String("MOCK_PNG_EXPECTATIONS").pipe(
    Config.withDefault("[]"),
  );
  if (port < 0 || port > 65535) {
    return yield* new FixtureError({ message: "invalid MOCK_PORT" });
  }
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(path);
  const fixture = yield* Effect.try({
    try: () => JSON.parse(contents) as unknown,
    catch: (cause) => new FixtureError({ message: `invalid JSON in ${path}`, cause }),
  });
  const pngExpectations = yield* Effect.try({
    try: () => decodePngExpectations(JSON.parse(rawPngExpectations) as unknown),
    catch: (cause) => new FixtureError({ message: "invalid MOCK_PNG_EXPECTATIONS", cause }),
  });
  yield* createMockServer(fixture, { port, pngExpectations });
  yield* Effect.never;
});
NodeRuntime.runMain(Effect.scoped(main).pipe(Effect.provide(NodeServices.layer)));
