import type { RunContext } from "@litellm-bench/harness";
import {
  canonicalOpenAiChatCompletions,
  canonicalOpenAiChatCompletionsFixturePath,
  canonicalOpenAiChatCompletionsResponseBytes,
} from "@litellm-bench/provider-openai-chat-completions";
import {
  allocateVirtualUsers,
  type ProxyExperiment,
  type ProxyTrialPlan,
} from "@litellm-bench/proxy";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
export interface ChatExperimentConfig {
  readonly rounds: number;
  readonly arrival_rates: readonly number[];
  readonly duration_seconds: number;
  readonly warmup_seconds: number;
  readonly steady_state?: {
    readonly window_seconds: number;
    readonly windows: number;
    readonly maximum_cv: number;
  };
  readonly slo: { readonly p95_latency_ms: number };
  readonly vu_allocation: { readonly slo_multiple: number; readonly minimum_vus: number };
  readonly max_vus: number;
  readonly calibration_rate_multiplier: number;
  readonly mock_image: string;
  readonly resources: {
    readonly cpus: number;
    readonly memory: string;
    readonly workers: number;
    readonly idle_seconds: number;
    readonly log_driver: string;
    readonly mock_cpus?: number;
    readonly mock_memory?: string;
    readonly cpu_sets?: {
      readonly proxy: string;
      readonly mock: string;
      readonly load_generator: string;
    };
  };
}

const shuffled = <T>(values: readonly T[], seed: string): T[] => {
  const output = [...values];
  let state = Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16);
  for (let index = output.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const target = state % (index + 1);
    [output[index], output[target]] = [output[target]!, output[index]!];
  }
  return output;
};

export const makeChatExperiment = (
  context: RunContext,
  config: ChatExperimentConfig,
  image: string,
): ProxyExperiment => {
  const proxyBody = Buffer.from(JSON.stringify({
    model: "mock-chat",
    messages: canonicalOpenAiChatCompletions.messages,
    stream: false,
  }));
  const directBody = Buffer.from(JSON.stringify({
    model: canonicalOpenAiChatCompletions.model,
    messages: canonicalOpenAiChatCompletions.messages,
    stream: false,
  }));
  const proxyConfigPath = fileURLToPath(new URL("../proxy_config.yaml", import.meta.url));
  const fixturePath = canonicalOpenAiChatCompletionsFixturePath;
  const load = (rate: number) => ({
    mode: "fixed" as const,
    rate,
    ...allocateVirtualUsers(rate, config.slo.p95_latency_ms / 1_000, {
      ...config.vu_allocation,
      maximum_vus: config.max_vus,
    }),
    duration_seconds: config.duration_seconds,
    warmup_seconds: config.warmup_seconds,
    ...(config.steady_state === undefined ? {} : { steady_state: config.steady_state }),
  });
  const common = { proxyConfigPath, fixturePath, mockImage: config.mock_image };
  const workload = (body: Uint8Array, direct = false) => ({
    body,
    request: {
      method: "POST",
      path: "/v1/chat/completions",
      headers: {
        "Content-Type": "application/json",
        ...(direct ? { Authorization: "Bearer sk-mock" } : {}),
      },
    },
    response: {
      status: 200,
      jsonEquals: [
        { path: ["object"], value: "chat.completion" },
        { path: ["choices", 0, "message", "role"], value: "assistant" },
        {
          path: ["choices", 0, "message", "content"],
          value: canonicalOpenAiChatCompletions.response,
        },
        { path: ["choices", 0, "finish_reason"], value: "stop" },
        { path: ["usage", "total_tokens"], value: canonicalOpenAiChatCompletions.totalTokens },
      ],
    },
  });
  const trials: ProxyTrialPlan[] = [];
  for (let round = 1; round <= config.rounds; round += 1) {
    for (const rate of shuffled(config.arrival_rates, `${context.spec.comparison_id}:${round}`)) {
      trials.push({
        ...common,
        id: `nonstream_rate${rate}_r${round}`,
        scenario: "nonstream-arrival-sweep",
        variant: `rate-${rate}`,
        round,
        load: load(rate),
        workload: workload(proxyBody),
        dimensions: {
          offered_rps: rate,
          wire_body_bytes: proxyBody.byteLength,
          response_content_bytes: canonicalOpenAiChatCompletionsResponseBytes,
          stream: false,
          calibration: false,
        },
      });
    }
    const calibrationRate = Math.max(...config.arrival_rates)
      * config.calibration_rate_multiplier;
    trials.push({
      ...common,
      id: `calibration_rate${calibrationRate}_r${round}`,
      scenario: "nonstream-arrival-sweep",
      variant: "bypass-calibration",
      round,
      load: load(calibrationRate),
      workload: workload(directBody, true),
      bypassProxy: true,
      dimensions: {
        offered_rps: calibrationRate,
        wire_body_bytes: directBody.byteLength,
        response_content_bytes: canonicalOpenAiChatCompletionsResponseBytes,
        stream: false,
        calibration: true,
      },
    });
  }
  return {
    image,
    artifactsDirectory: context.artifactsDirectory,
    resources: {
      cpus: config.resources.cpus,
      memory: config.resources.memory,
      workers: config.resources.workers,
      idleSeconds: config.resources.idle_seconds,
      logDriver: config.resources.log_driver,
      ...(config.resources.cpu_sets?.proxy === undefined
        ? {}
        : { proxyCpuSet: config.resources.cpu_sets.proxy }),
      ...(config.resources.cpu_sets?.mock === undefined
        ? {}
        : { mockCpuSet: config.resources.cpu_sets.mock }),
      ...(config.resources.cpu_sets?.load_generator === undefined
        ? {}
        : { loadGeneratorCpuSet: config.resources.cpu_sets.load_generator }),
      ...(config.resources.mock_cpus === undefined ? {} : { mockCpus: config.resources.mock_cpus }),
      ...(config.resources.mock_memory === undefined
        ? {}
        : { mockMemory: config.resources.mock_memory }),
    },
    trials,
  };
};
