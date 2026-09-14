import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readCampaignPlan } from "./campaign-plan.mjs";

const runner = fileURLToPath(new URL("./run-campaign.mjs", import.meta.url));
const entry = (version, position, ids = ["sdk-import-time"]) => ({
  version,
  comparison_order: { position },
  jobs: ids.map((id) => ({ benchmark_id: id, benchmark_job: "base" })),
});

test("rejects malformed, empty, and colliding plans before starting benchmarks", () => {
  for (
    const plan of [
      "{",
      "null",
      "{}",
      "{\"include\":[]}",
      JSON.stringify({ include: [entry("1", "../outside")] }),
      JSON.stringify({ include: [entry("1", 0)] }),
      JSON.stringify({ include: [entry("1", 1), entry("2", 1)] }),
      JSON.stringify({ include: [entry("", 1)] }),
      JSON.stringify({ include: [entry("1", 1, [])] }),
    ]
  ) assert.throws(() => readCampaignPlan(plan));
});

for (const failFirst of [false, true]) {
  test(`campaign retains plan order and ${failFirst ? "continues after failures" : "succeeds"}`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "litellm-bench-workflow-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const bin = join(directory, "bin");
    const calls = join(directory, "calls.jsonl");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "pnpm"),
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify(args) + '\\n');
process.exit(args[args.indexOf('--version') + 1] === process.env.TEST_FAIL_VERSION ? 1 : 0);
`,
      { mode: 0o755 },
    );
    const plan = { include: [entry("1.100.1", 2), entry("1.100.0", 1)] };
    const result = spawnSync(process.execPath, [runner], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        CAMPAIGN_PLAN: JSON.stringify(plan),
        TEST_CALLS: calls,
        TEST_FAIL_VERSION: failFirst ? "1.100.1" : "",
      },
    });
    assert.equal(result.status, failFirst ? 1 : 0, result.stderr);
    assert(existsSync(join(directory, "data/runs/benchmark-output")));
    const commands = readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(
      commands,
      plan.include.map((entry) => [
        "bench",
        "run-version",
        "--version",
        entry.version,
        "--plan-json",
        JSON.stringify(entry),
        "--output",
        `data/runs/benchmark-output/${entry.comparison_order.position}`,
      ]),
    );
  });
}
