import { expect, it } from "vitest";

import { projectOcr } from "./projection.js";
import { trialSchedule } from "./schedule.js";
import type { OcrObservation, OcrScenario } from "./types.js";

const scenario: OcrScenario = {
  id: "core",
  label: "Core",
  payload_bytes: 10,
  concurrency: 2,
  load_model: "closed",
};
const row = (label: string, variant: "python" | "rust", rps: number): OcrObservation => ({
  label,
  variant,
  payload_requested_bytes: 10,
  wire_body_bytes: 12,
  document_bytes: 10,
  document_sha256: "a".repeat(64),
  load_model: "closed",
  concurrency: 2,
  requests: 10,
  successes: 10,
  failures: 0,
  completion_rps: rps,
  p95_ms: 2,
  cpu_average_percent: 90,
  peak_memory_mib: 100,
  idle_anon_mib: 80,
});

it("uses seeded adjacent blocks and computes per-round Rust/Python ratios", () => {
  expect(trialSchedule([scenario], 2).map(([, variant]) => variant)).toEqual([
    "rust",
    "python",
    "rust",
    "python",
  ]);
  const projected = projectOcr(
    [
      row("core_r1", "rust", 20),
      row("core_r1", "python", 10),
      row("core_r2", "rust", 30),
      row("core_r2", "python", 10),
    ],
    [scenario],
    2,
  );
  expect(projected.metrics.find(({ id }) => id === "core.paired_ratio")?.value).toBe(2.5);
  expect(projected.trials).toHaveLength(4);
});
