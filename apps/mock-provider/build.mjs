import { build } from "esbuild";

// Docker mounts only dist: no workspace symlinks or node_modules may be required.
await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  platform: "node",
  target: "node24",
  format: "esm",
  bundle: true,
  sourcemap: true,
  banner: {
    js:
      "import { createRequire as __createRequire } from \"node:module\"; const require = __createRequire(import.meta.url);",
  },
});
