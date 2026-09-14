import type { RunContext } from "@litellm-bench/harness";
import {
  canonicalMistralOcr,
  canonicalMistralOcrFixturePath,
} from "@litellm-bench/provider-mistral-ocr";
import type { ProxyExperiment, ProxyTrialPlan } from "@litellm-bench/proxy";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { OcrConfig } from "./config.js";
import { multipartBody } from "./payload.js";
import { type ScheduledTrial, trialSchedule } from "./schedule.js";
import type { OcrScenario } from "./types.js";

type Multipart = ReturnType<typeof multipartBody>;

const buildTrialPlan = (
  config: typeof OcrConfig.Type,
  payloads: ReadonlyMap<string, Multipart>,
) =>
({ scenario, variant, round }: ScheduledTrial): ProxyTrialPlan => {
  const multipart = payloads.get(scenario.id)!;
  const documentSha256 = createHash("sha256").update(multipart.document).digest("hex");
  return {
    id: `${scenario.id}_${variant}_r${round}`,
    scenario: scenario.id,
    variant,
    round,
    load: {
      mode: "closed",
      concurrency: scenario.concurrency,
      duration_seconds: config.duration_seconds,
      warmup_seconds: config.warmup_seconds,
    },
    workload: {
      body: multipart.body,
      request: {
        method: "POST",
        path: "/v1/ocr",
        headers: { "Content-Type": `multipart/form-data; boundary=${multipart.boundary}` },
      },
      response: {
        status: 200,
        jsonEquals: [
          { path: ["model"], value: "mock-ocr" },
          { path: ["pages", 0, "markdown"], value: canonicalMistralOcr.markdown },
          { path: ["usage_info", "pages_processed"], value: 1 },
        ],
      },
    },
    proxyConfigPath: fileURLToPath(new URL("../proxy_config.yaml", import.meta.url)),
    fixturePath: canonicalMistralOcrFixturePath,
    mockImage: config.mock_image,
    mockEnvironment: {
      MOCK_PNG_EXPECTATIONS: JSON.stringify([{
        path: "document.image_url",
        bytes: multipart.document.byteLength,
        sha256: documentSha256,
      }]),
    },
    isolateMeasurementWindow: true,
    environment: { LITELLM_RUST: variant === "rust" ? "1" : "0" },
    dimensions: {
      payload_requested_bytes: scenario.payload_bytes,
      document_bytes: multipart.document.byteLength,
      document_sha256: documentSha256,
      wire_body_bytes: multipart.body.byteLength,
    },
  };
};

export const makeOcrExperiment = (
  context: RunContext,
  config: typeof OcrConfig.Type,
  scenarios: readonly OcrScenario[],
  image: string,
): ProxyExperiment => {
  const payloads = new Map(
    scenarios.map((scenario) => [scenario.id, multipartBody(scenario.payload_bytes)]),
  );
  return {
    image,
    artifactsDirectory: context.artifactsDirectory,
    resources: {
      cpus: config.cpus,
      proxyCpuSet: config.proxy_cpu_set,
      mockCpuSet: config.mock_cpu_set,
      loadGeneratorCpuSet: config.load_generator_cpu_set,
      mockCpus: config.mock_cpus,
      memory: config.memory,
      mockMemory: config.mock_memory,
      workers: config.workers,
      idleSeconds: config.idle_seconds,
      logDriver: config.log_driver,
    },
    trials: trialSchedule(scenarios, config.rounds, config.order_seed).map(
      buildTrialPlan(config, payloads),
    ),
  };
};
