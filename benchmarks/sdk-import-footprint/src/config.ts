import { SdkBenchmarkSpec } from "@litellm-bench/contracts";
import {
  captureHostEnvironment,
  InvalidRunnerConfig,
  type RunContext,
} from "@litellm-bench/harness";
import { Effect, Schema } from "effect";

export interface HostRuntime {
  readonly platform: string;
  readonly architecture: string;
}
export const currentHost: HostRuntime = captureHostEnvironment();
const Config = Schema.Struct({
  workload: SdkBenchmarkSpec.fields.workload,
  measurements: SdkBenchmarkSpec.fields.measurements,
  resolver: Schema.optionalKey(SdkBenchmarkSpec.fields.resolver),
  environment: Schema.optionalKey(SdkBenchmarkSpec.fields.environment),
  profile: Schema.optionalKey(Schema.Literal("base")),
});

export const decodeImportFootprintSpec = Effect.fn("ImportFootprint.decodeConfig")(
  function*(context: RunContext) {
    const config = yield* Schema.decodeUnknownEffect(Config, { onExcessProperty: "error" })(
      context.spec.job.config,
    ).pipe(Effect.mapError((error) => new InvalidRunnerConfig({ message: error.message })));
    const subject = yield* Schema.decodeUnknownEffect(SdkBenchmarkSpec.fields.subject, {
      onExcessProperty: "error",
    })(context.spec.artifact).pipe(
      Effect.mapError((error) => new InvalidRunnerConfig({ message: error.message })),
    );
    const { measurements } = config;
    if (
      !measurements.diagnostics || measurements.timing || measurements.importtime
      || measurements.network || measurements.warmups !== 0 || measurements.samples !== 1
    ) {
      return yield* new InvalidRunnerConfig({
        message:
          "Import footprint requires one diagnostic observation, one first import, and no timing, network, or importtime probes",
      });
    }
    const python = context.spec.job.requirements?.python;
    if (python === undefined) {
      return yield* new InvalidRunnerConfig({ message: "SDK job requires requirements.python" });
    }
    const host = context.host ?? captureHostEnvironment();
    return {
      subject,
      runtime: {
        python,
        platform: host.platform,
        architecture: host.architecture,
      },
      workload: config.workload,
      measurements,
      resolver: config.resolver ?? { extra_index_urls: [], find_links: [], binary_only: false },
      environment: config.environment ?? {},
      profile: config.profile ?? "base",
    } satisfies SdkBenchmarkSpec;
  },
);
