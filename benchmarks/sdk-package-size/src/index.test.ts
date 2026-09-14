import { describe, expect, it } from "vitest";

import { projectPackageSize } from "./result.js";

const raw = {
  runtime: {},
  diagnostics: {},
  resolution: {
    artifact_count: 2,
    download_bytes: 2_097_152,
    package_artifact_bytes: 1_048_576,
    artifacts: [],
  },
  size: { installed_before_first_run: { logical_bytes: 3_145_728 } },
} as const;

describe("package-size projection", () => {
  it("keeps wheel, closure, installation, and artifact count distinct", () => {
    expect(projectPackageSize(raw).map(({ id, value }) => [id, value])).toEqual([
      ["package.wheel", 1],
      ["package.download", 2],
      ["package.installed", 3],
      ["package.artifacts", 2],
    ]);
  });
});
