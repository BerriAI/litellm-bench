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

export const decodePackageSizeSpec = Effect.fn("PackageSize.decodeConfig")(
  function*(context: RunContext) {
    const config = yield* Schema.decodeUnknownEffect(Config, { onExcessProperty: "error" })(
      context.spec.job.config,
    ).pipe(
      Effect.mapError((error) => new InvalidRunnerConfig({ message: error.message })),
    );
    const subject = yield* Schema.decodeUnknownEffect(SdkBenchmarkSpec.fields.subject, {
      onExcessProperty: "error",
    })(context.spec.artifact).pipe(
      Effect.mapError((error) => new InvalidRunnerConfig({ message: error.message })),
    );
    const { measurements } = config;
    if (
      measurements.timing || measurements.diagnostics || measurements.importtime
      || measurements.network || measurements.warmups !== 0 || measurements.samples !== 1
    ) {
      return yield* new InvalidRunnerConfig({
        message: "Package size requires one uninstrumented observation and no warmups",
      });
    }
    if (config.resolver?.binary_only === false) {
      return yield* new InvalidRunnerConfig({
        message: "Package size requires resolver.binary_only=true",
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
      resolver: config.resolver ?? { extra_index_urls: [], find_links: [], binary_only: true },
      environment: config.environment ?? {},
      profile: config.profile ?? "base",
    } satisfies SdkBenchmarkSpec;
  },
);
