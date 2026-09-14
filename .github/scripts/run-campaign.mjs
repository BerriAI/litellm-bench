import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { readCampaignPlan } from "./campaign-plan.mjs";

const plan = readCampaignPlan();
const output = "data/runs/benchmark-output";
mkdirSync(output, { recursive: true });
let status = 0;
for (const entry of plan.include) {
  console.log(`::group::LiteLLM ${entry.version} (position ${entry.comparison_order.position})`);
  const result = spawnSync("pnpm", [
    "bench",
    "run-version",
    "--version",
    entry.version,
    "--plan-json",
    JSON.stringify(entry),
    "--output",
    `${output}/${entry.comparison_order.position}`,
  ], { stdio: "inherit" });
  console.log("::endgroup::");
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Benchmark interrupted by ${result.signal}`);
  if (result.status !== 0) status = 1;
}
process.exitCode = status;
