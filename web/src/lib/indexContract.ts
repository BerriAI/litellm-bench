import { decodeStrict } from "@litellm-bench/contracts";
import {
  BenchmarkIndex,
  type BenchmarkIndex as BenchmarkIndexType,
  validateBenchmarkIndex,
} from "@litellm-bench/contracts/results";

export function parseIndex(value: unknown): BenchmarkIndexType {
  try {
    const decoded = decodeStrict(BenchmarkIndex)(value);
    const issues = validateBenchmarkIndex(decoded);
    if (issues.length) {
      throw new Error(issues.map((issue) => `${issue.path}: ${issue.message}`).join(", "));
    }
    return decoded;
  } catch (error) {
    throw new Error(`Invalid benchmark index: ${String(error)}`, { cause: error });
  }
}
