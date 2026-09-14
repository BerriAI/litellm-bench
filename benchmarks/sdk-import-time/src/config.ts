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

export const currentHost: HostRuntime = {
  platform: captureHostEnvironment().platform,
  architecture: captureHostEnvironment().architecture,
};

const ImportTimeConfig = Schema.Struct({
  workload: SdkBenchmarkSpec.fields.workload,
  measurements: SdkBenchmarkSpec.fields.measurements,
  resolver: Schema.optionalKey(SdkBenchmarkSpec.fields.resolver),
  environment: Schema.optionalKey(SdkBenchmarkSpec.fields.environment),
  profile: Schema.optionalKey(Schema.Literal("base")),
});

export const decodeImportTimeSpec = Effect.fn("ImportTime.decodeConfig")(function*(
  context: RunContext,
) {
  const config = yield* Schema.decodeUnknownEffect(ImportTimeConfig, { onExcessProperty: "error" })(
    context.spec.job.config,
  ).pipe(Effect.mapError((error) => new InvalidRunnerConfig({ message: error.message })));
  const subject = yield* Schema.decodeUnknownEffect(SdkBenchmarkSpec.fields.subject, {
    onExcessProperty: "error",
  })(context.spec.artifact).pipe(
    Effect.mapError((error) => new InvalidRunnerConfig({ message: error.message })),
  );
  if (
    !config.measurements.timing || config.measurements.diagnostics || config.measurements.network
  ) {
    return yield* new InvalidRunnerConfig({
      message: "Import timing requires timing=true, diagnostics=false, and network=false",
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
    measurements: config.measurements,
    resolver: config.resolver ?? { extra_index_urls: [], find_links: [], binary_only: false },
    environment: config.environment ?? {},
    profile: config.profile ?? "base",
  } satisfies SdkBenchmarkSpec;
});
