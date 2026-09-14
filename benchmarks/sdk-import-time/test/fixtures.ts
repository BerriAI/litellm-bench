import { BenchmarkDefinition, type SdkBenchmarkSpec } from "@litellm-bench/contracts";
import type { RunContext } from "@litellm-bench/harness";
import type { PreparedEnvironment } from "@litellm-bench/python-environment";
import { Schema } from "effect";
import { readFileSync } from "node:fs";

const definition = Schema.decodeUnknownSync(BenchmarkDefinition)(
  JSON.parse(readFileSync(new URL("../benchmark.json", import.meta.url), "utf8")),
);

export const spec: SdkBenchmarkSpec = {
  subject: { requirement: "litellm==1.0.0", distribution: "litellm" },
  runtime: { python: "3.12", platform: "linux", architecture: "x86_64" },
  workload: { name: "root-import", statement: "import litellm" },
  measurements: {
    warmups: 2,
    samples: 3,
    timing: true,
    diagnostics: false,
    importtime: false,
    network: false,
    timeout_seconds: 2,
  },
  resolver: { extra_index_urls: [], find_links: [], binary_only: false },
  environment: {},
  profile: "base",
};

export const context: RunContext = {
  runId: "import-time-test",
  createdAt: "2026-09-13T00:00:00Z",
  artifactsDirectory: "/artifacts",
  host: {
    platform: "linux",
    architecture: "x86_64",
    host: "existing",
    node_version: process.version,
    ci: false,
  },
  spec: {
    case_id: "a".repeat(64),
    comparison_id: "b".repeat(64),
    benchmark: {
      id: definition.id,
      label: definition.label!,
      kind: definition.kind,
      output_metrics: definition.output_metrics,
      protocol: definition.protocol,
    },
    job: {
      id: "base",
      canonical: true,
      runner: "test",
      requirements: { platform: "linux", architecture: "x86_64", python: "3.12" },
      config: {
        workload: spec.workload,
        measurements: spec.measurements,
      },
    },
    version: { version: "1.0.0", artifacts: {} },
    artifact: spec.subject,
  },
};

export const prepared: PreparedEnvironment = {
  workspace: "/workspace",
  python: "/workspace/bin/python",
  site_packages: [],
  installed_files: [],
  downloads: "/workspace/downloads",
  pip_report: "/artifacts/pip-report.json",
  artifacts: [{ filename: "litellm.whl", bytes: 50, sha256: "a".repeat(64) }],
  package_version: "1.0.0",
  python_metadata: { version: "3.12.0", implementation: "CPython" },
  uv_version: "uv test",
  pip_version: "pip test",
};
