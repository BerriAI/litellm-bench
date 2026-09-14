import { RunnerExecutionError } from "@litellm-bench/harness";
import type { ProxyRuntimeError } from "./runtime.js";

export const toRunnerExecutionError = (
  error: ProxyRuntimeError,
): RunnerExecutionError =>
  new RunnerExecutionError({
    message: `${error.operation}: ${error.message}`,
    cause: error,
  });
