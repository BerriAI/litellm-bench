import { NodePath } from "@effect/platform-node";
import adapter from "@sveltejs/adapter-static";
import { Effect, Path } from "effect";

const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1];
const isProjectPage = repositoryName && !repositoryName.endsWith(".github.io");
const base = process.env.BASE_PATH ?? (isProjectPage ? `/${repositoryName}` : "");
const path = Effect.runSync(Path.Path.pipe(Effect.provide(NodePath.layer)));
const output = path.resolve(process.env.BENCHMARK_SITE_DIR ?? "dist");

/** @type {import("@sveltejs/kit").Config} */
const config = {
  kit: {
    adapter: adapter({
      pages: output,
      assets: output,
    }),
    paths: { base },
  },
};

export default config;
