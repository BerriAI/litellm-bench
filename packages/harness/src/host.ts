import type { JsonRecord } from "@litellm-bench/contracts";
import type {
  EnvironmentRequirements,
  HostEnvironmentSnapshot,
} from "@litellm-bench/contracts/metadata";
import { cpus as hostCpus, loadavg, release, totalmem } from "node:os";

export type HostPlatform = "linux" | "macos" | "windows" | "unknown";
export type HostArchitecture = "x86_64" | "arm64" | "unknown";

export type { HostEnvironmentSnapshot };

export const normalizePlatform = (platform: NodeJS.Platform): HostPlatform =>
  platform === "darwin" ? "macos" : platform === "win32"
    ? "windows"
    : platform === "linux"
    ? "linux"
    : "unknown";

export const normalizeArchitecture = (architecture: string): HostArchitecture =>
  architecture === "x64" || architecture === "x86_64"
    ? "x86_64"
    : architecture === "arm64"
    ? "arm64"
    : "unknown";

const captureHostResources = (): Pick<
  HostEnvironmentSnapshot,
  "kernel_release" | "cpu_model" | "cpu_count" | "memory_total_bytes" | "load_average_1m"
> => {
  const cpus = hostCpus();
  const model = cpus[0]?.model.trim();
  const kernel = release();
  const load = loadavg()[0];
  return {
    ...(kernel === "" ? {} : { kernel_release: kernel }),
    ...(model === undefined || model === "" ? {} : { cpu_model: model }),
    ...(cpus.length === 0 ? {} : { cpu_count: cpus.length }),
    memory_total_bytes: totalmem(),
    ...(load === undefined || !Number.isFinite(load) ? {} : { load_average_1m: load }),
  };
};

export const captureHostEnvironment = (
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): HostEnvironmentSnapshot => ({
  platform: normalizePlatform(platform),
  architecture: normalizeArchitecture(architecture),
  host: environment.LITELLM_BENCH_HOST === "github-hosted"
      || environment.RUNNER_ENVIRONMENT === "github-hosted"
    ? "github-hosted"
    : "existing",
  node_version: process.version,
  ci: environment.CI === "true" || environment.GITHUB_ACTIONS === "true",
  ...captureHostResources(),
});

export const checkHostRequirements = (
  requirements: EnvironmentRequirements | undefined,
  actual: HostEnvironmentSnapshot,
): {
  readonly message: string;
  readonly required: JsonRecord;
  readonly actual: HostEnvironmentSnapshot;
} | undefined => {
  if (requirements === undefined) return undefined;
  const mismatches = [
    ...(requirements.platform === undefined || requirements.platform === actual.platform
      ? []
      : [`platform requires ${requirements.platform}, found ${actual.platform}`]),
    ...(requirements.architecture === undefined || requirements.architecture === actual.architecture
      ? []
      : [`architecture requires ${requirements.architecture}, found ${actual.architecture}`]),
    ...(requirements.host === undefined || requirements.host === actual.host
      ? []
      : [`host requires ${requirements.host}, found ${actual.host}`]),
  ];
  return mismatches.length === 0
    ? undefined
    : {
      message: `Host environment does not satisfy benchmark requirements: ${mismatches.join("; ")}`,
      required: { ...requirements },
      actual,
    };
};
