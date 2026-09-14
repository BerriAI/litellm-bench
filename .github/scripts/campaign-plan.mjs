import assert from "node:assert/strict";

export function readCampaignPlan(value = process.env.CAMPAIGN_PLAN) {
  const plan = JSON.parse(value);
  assert(Array.isArray(plan.include) && plan.include.length > 0, "Campaign has no versions");
  const positions = new Set();
  for (const entry of plan.include) {
    assert(typeof entry.version === "string" && entry.version.length > 0, "Missing version");
    assert(Array.isArray(entry.jobs) && entry.jobs.length > 0, "Version has no jobs");
    const position = entry.comparison_order?.position;
    assert(Number.isSafeInteger(position) && position > 0, "Invalid comparison position");
    assert(!positions.has(position), "Duplicate comparison position");
    positions.add(position);
  }
  return plan;
}
