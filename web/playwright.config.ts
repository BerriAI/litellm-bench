import { defineConfig } from "@playwright/test";

const base = process.env.BASE_PATH ?? "";
export default defineConfig({
  testDir: "./tests/browser",
  use: { baseURL: `http://127.0.0.1:4175${base}/`, browserName: "chromium" },
  webServer: {
    command: "pnpm build && pnpm preview",
    url: `http://127.0.0.1:4175${base}/`,
    env: {
      PORT: "4175",
      BASE_PATH: base,
      BENCHMARK_DATA_DIR: "tests/fixtures/data",
      BENCHMARK_SITE_DIR: "dist/browser",
    },
    timeout: 120_000,
  },
});
