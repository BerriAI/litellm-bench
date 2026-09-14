import type { Analysis, Metric, Trial } from "@litellm-bench/contracts";

export type OcrVariant = "python" | "rust";

export interface OcrScenario {
  readonly id: string;
  readonly label: string;
  readonly payload_bytes: number;
  readonly concurrency: number;
  readonly load_model: string;
}

export interface OcrObservation {
  readonly label: string;
  readonly variant: OcrVariant;
  readonly payload_requested_bytes: number;
  readonly wire_body_bytes: number;
  readonly document_bytes: number;
  readonly document_sha256: string;
  readonly load_model: string;
  readonly concurrency: number;
  readonly requests: number;
  readonly successes: number;
  readonly failures: number;
  readonly completion_rps: number;
  readonly p95_ms: number;
  readonly cpu_average_percent: number;
  readonly cpu_ms_per_request: number;
  readonly peak_memory_mib: number;
  readonly peak_memory_growth_mib: number;
  readonly idle_anon_mib: number;
  readonly idle_anon_growth_mib: number;
  readonly mock_cpu_average_percent: number;
  readonly load_generator_cpu_percent: number;
}

export interface OcrProjection {
  readonly metrics: readonly Metric[];
  readonly analyses: readonly Analysis[];
  readonly trials: readonly Trial[];
}
