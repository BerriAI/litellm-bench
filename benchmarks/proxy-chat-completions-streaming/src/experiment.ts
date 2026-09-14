import type { RunContext } from "@litellm-bench/harness";
import type { ProxyExperiment, ProxyTrialPlan } from "@litellm-bench/proxy";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { StreamingChatConfig } from "./config.js";

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

const streamExpectation = {
  event_count: 7,
  terminal_data: "[DONE]",
  jsonEquals: [
    { index: 0, path: ["object"], value: "chat.completion.chunk" },
    { index: 0, path: ["choices", 0, "delta", "role"], value: "assistant" },
    { index: 1, path: ["choices", 0, "delta", "content"], value: "mock " },
    { index: 2, path: ["choices", 0, "delta", "content"], value: "streaming " },
    { index: 3, path: ["choices", 0, "delta", "content"], value: "chat " },
    { index: 4, path: ["choices", 0, "delta", "content"], value: "response" },
    { index: 5, path: ["choices", 0, "finish_reason"], value: "stop" },
  ],
};

export const makeStreamingChatExperiment = (
  context: RunContext,
  config: typeof StreamingChatConfig.Type,
  image: string,
): ProxyExperiment => {
  const body = (model: string) =>
    Buffer.from(JSON.stringify({
      model,
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    }));
  const proxyBody = body("mock-chat");
  const directBody = body("bench-model");
  const proxyConfigPath = fileURLToPath(new URL("../proxy_config.yaml", import.meta.url));
  const fixturePath = fileURLToPath(new URL("../upstream.json", import.meta.url));
  const load = (rate: number) => ({
    mode: "fixed" as const,
    rate,
    preallocated_vus: config.preallocated_vus,
    max_vus: config.max_vus,
    duration_seconds: config.duration_seconds,
    warmup_seconds: config.warmup_seconds,
    steady_state: config.steady_state,
  });
  const common = { proxyConfigPath, fixturePath, mockImage: config.mock_image };
  const workload = (payload: Uint8Array, direct = false) => ({
    body: payload,
    request: {
      method: "POST",
      path: "/v1/chat/completions",
      headers: {
        "Content-Type": "application/json",
        ...(direct ? { Authorization: "Bearer sk-mock" } : {}),
      },
    },
    response: { status: 200, jsonEquals: [], sse: streamExpectation },
  });
  const trials: ProxyTrialPlan[] = [];
  for (let round = 1; round <= config.rounds; round += 1) {
    for (
      const rate of shuffled(config.arrival_rates, `${context.spec.comparison_id}:${round}`)
    ) {
      trials.push({
        ...common,
        id: `stream_rate${rate}_r${round}`,
        scenario: "stream-arrival-sweep",
        variant: `rate-${rate}`,
        round,
        load: load(rate),
        workload: workload(proxyBody),
        dimensions: {
          offered_rps: rate,
          wire_body_bytes: proxyBody.byteLength,
          stream: true,
          stream_events: streamExpectation.event_count,
          calibration: false,
        },
      });
    }
    const calibrationRate = Math.max(...config.arrival_rates)
      * config.calibration_rate_multiplier;
    trials.push({
      ...common,
      id: `calibration_rate${calibrationRate}_r${round}`,
      scenario: "stream-arrival-sweep",
      variant: "bypass-calibration",
      round,
      load: load(calibrationRate),
      workload: workload(directBody, true),
      bypassProxy: true,
      dimensions: {
        offered_rps: calibrationRate,
        wire_body_bytes: directBody.byteLength,
        stream: true,
        stream_events: streamExpectation.event_count,
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
      proxyCpuSet: config.resources.cpu_sets.proxy,
      mockCpuSet: config.resources.cpu_sets.mock,
      loadGeneratorCpuSet: config.resources.cpu_sets.load_generator,
      mockCpus: config.resources.mock_cpus,
      mockMemory: config.resources.mock_memory,
    },
    trials,
  };
};
