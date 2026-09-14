import type { RunContext } from "@litellm-bench/harness";
import type { ProxyExperiment } from "@litellm-bench/proxy";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { OcrConfig } from "./config.js";
import { multipartBody } from "./payload.js";
import { trialSchedule } from "./schedule.js";
import type { OcrScenario } from "./types.js";

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
      ([scenario, variant, round]) => {
        const multipart = payloads.get(scenario.id)!;
        const documentSha256 = createHash("sha256").update(multipart.document).digest("hex");
        return {
          id: `${scenario.id}_${variant}_r${round}`,
          scenario: scenario.id,
          variant,
          round,
          load: {
            mode: "closed" as const,
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
                { path: ["pages", 0, "markdown"], value: "mock OCR response" },
                { path: ["usage_info", "pages_processed"], value: 1 },
              ],
            },
          },
          proxyConfigPath: fileURLToPath(new URL("../proxy_config.yaml", import.meta.url)),
          fixturePath: fileURLToPath(new URL("../upstream.json", import.meta.url)),
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
      },
    ),
  };
};
