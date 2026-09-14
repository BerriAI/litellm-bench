import { NodePath } from "@effect/platform-node";
import { Effect, Path } from "effect";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { deriveIndex } from "@litellm-bench/result-store";
import { parseAnnotations } from "../src/lib/annotationContract.ts";

const path = Effect.runSync(Path.Path.pipe(Effect.provide(NodePath.layer)));
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = path.resolve(source, process.env.BENCHMARK_DATA_DIR ?? "../data");
const output = path.resolve(source, process.env.BENCHMARK_SITE_DIR ?? "dist");
const outputWithinData = path.relative(data, output);

if (output === source || output === data || output === path.parse(output).root) {
  throw new Error("BENCHMARK_SITE_DIR must be a dedicated build directory");
}
if (outputWithinData && !outputWithinData.startsWith("..")) {
  throw new Error("BENCHMARK_SITE_DIR cannot be inside BENCHMARK_DATA_DIR");
}
if (existsSync(path.join(data, "annotations.json"))) {
  parseAnnotations(JSON.parse(readFileSync(path.join(data, "annotations.json"), "utf8")));
}

rmSync(output, { recursive: true, force: true });
const svelteKit = spawnSync(
  process.execPath,
  [path.join(source, "node_modules/vite/bin/vite.js"), "build"],
  {
    cwd: source,
    env: { ...process.env, BENCHMARK_DATA_DIR: data },
    stdio: "inherit",
  },
);

if (svelteKit.error) throw svelteKit.error;
if (svelteKit.status !== 0) process.exit(svelteKit.status ?? 1);

cpSync(data, path.join(output, "data"), {
  recursive: true,
  filter: (source) => path.resolve(source) !== path.join(data, "index.json"),
});
writeFileSync(
  path.join(output, "data", "index.json"),
  `${JSON.stringify(await deriveIndex(data), null, 2)}\n`,
);
writeFileSync(path.join(output, ".nojekyll"), "");
console.log(output);
