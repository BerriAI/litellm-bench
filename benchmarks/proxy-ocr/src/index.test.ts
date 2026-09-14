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
  cpu_ms_per_request: 5,
  peak_memory_mib: 100,
  peak_memory_growth_mib: 20,
  idle_anon_mib: 80,
  idle_anon_growth_mib: 10,
  mock_cpu_average_percent: 25,
  load_generator_cpu_percent: 50,
});

it("uses seeded adjacent blocks and computes per-round Rust/Python ratios", () => {
  expect(trialSchedule([scenario], 2).map(({ variant }) => variant)).toEqual([
    "rust",
    "python",
    "rust",
    "python",
  ]);
  const projected = projectOcr(
    [
      row("core_r1", "python", 10),
      row("core_r1", "rust", 20),
      row("core_r2", "python", 10),
      row("core_r2", "rust", 30),
    ],
    [scenario],
    2,
  );
  expect(projected.metrics.find(({ id }) => id === "core.paired_ratio")?.value).toBe(2.5);
  expect(projected.trials).toHaveLength(4);
});

it.each(
  [
    [{ cpu_average_percent: 89 }, "proxy was not CPU-saturated"],
    [{ mock_cpu_average_percent: 80 }, "mock may be limiting"],
    [{ load_generator_cpu_percent: 160 }, "load generator may be limiting"],
  ] as const,
)("rejects a trial when the apparatus lacks headroom", (override, message) => {
  expect(() =>
    projectOcr(
      [
        { ...row("core_r1", "python", 10), ...override },
        row("core_r1", "rust", 20),
      ],
      [scenario],
      1,
    )
  ).toThrow(message);
});
