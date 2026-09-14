import { expect, it } from "vitest";
import { toRunnerExecutionError } from "./errors.js";
import { ProxyRuntimeError } from "./runtime.js";

it("adapts proxy runtime failures to runner execution failures", () => {
  const cause = new ProxyRuntimeError({
    operation: "verify Docker",
    message: "unavailable",
  });

  expect(toRunnerExecutionError(cause)).toMatchObject({
    _tag: "RunnerExecutionError",
    message: "verify Docker: unavailable",
    cause,
  });
});
