import { expect, it } from "vitest";

import { projectImportFootprint } from "./result.js";

it("projects probe and disk-growth observations without conflating units", () => {
  const metrics = projectImportFootprint({
    runtime: {},
    diagnostics: { peak_rss_bytes: 2_097_152, new_module_count: 12 },
    resolution: { artifact_count: 0, download_bytes: 0, artifacts: [] },
    size: {
      installed_before_first_run: { logical_bytes: 1 },
      first_run_logical_delta_bytes: 1_048_576,
    },
  });
  expect(metrics.map(({ value }) => value)).toEqual([2, 12, 1]);
});
