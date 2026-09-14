import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { decodeImportTimeSpec } from "../src/config.js";
import { context, spec } from "./fixtures.js";

const decode = (config: Record<string, unknown>) =>
  decodeImportTimeSpec({
    ...context,
    spec: {
      ...context.spec,
      job: { ...context.spec.job, config: config as typeof context.spec.job.config },
    },
  });

it.effect("decodes defaults without changing the submitted config", () =>
  Effect.gen(function*() {
    const decoded = yield* decodeImportTimeSpec(context);
    expect(decoded).toEqual(spec);
    expect(context.spec.job.config.profile).toBeUndefined();
  }));

for (
  const [name, changes] of [
    ["unknown config key", { typo: true }],
    ["unsupported profile", { profile: "diagnostic" }],
    ["null resolver", { resolver: null }],
    ["null environment", { environment: null }],
    ["zero samples", { measurements: { ...spec.measurements, samples: 0 } }],
    ["disabled timing", { measurements: { ...spec.measurements, timing: false } }],
    ["diagnostic instrumentation", { measurements: { ...spec.measurements, diagnostics: true } }],
    ["network instrumentation", { measurements: { ...spec.measurements, network: true } }],
    ["unknown nested key", { measurements: { ...spec.measurements, samplez: 5 } }],
  ] as const
) {
  it.effect(`rejects ${name}`, () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(decode({ ...context.spec.job.config, ...changes }));
      expect(error._tag).toBe("InvalidRunnerConfig");
    }));
}

it.effect("requires a declared Python runtime", () =>
  Effect.gen(function*() {
    const { requirements: _, ...job } = context.spec.job;
    const candidate = {
      ...context,
      spec: { ...context.spec, job },
    };
    const error = yield* Effect.flip(decodeImportTimeSpec(candidate));
    expect(error._tag).toBe("InvalidRunnerConfig");
  }));
