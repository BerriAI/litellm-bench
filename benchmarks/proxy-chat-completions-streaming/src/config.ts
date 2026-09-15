import { InvalidRunnerConfig, type RunContext } from "@litellm-bench/harness";
import { Effect, Schema } from "effect";

const Positive = Schema.Finite.pipe(Schema.check(Schema.isGreaterThan(0)));
const CpuSet = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isPattern(/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/)),
);

export const StreamingChatConfig = Schema.Struct({
  rounds: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(5))),
  arrival_rates: Schema.Array(Positive).pipe(Schema.check(Schema.isMinLength(3))),
  duration_seconds: Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(30))),
  warmup_seconds: Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(15))),
  steady_state: Schema.Struct({
    window_seconds: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
    windows: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(3))),
    maximum_cv: Schema.Finite.pipe(
      Schema.check(Schema.isBetween({ minimum: 0, maximum: 0.2 })),
    ),
  }),
  slo: Schema.Struct({
    p95_ttfb_ms: Positive,
    p95_stream_duration_ms: Positive,
    maximum_error_rate: Schema.Finite.pipe(
      Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    ),
    minimum_achievement_ratio: Schema.Finite.pipe(
      Schema.check(Schema.isBetween({ minimum: 0.9, maximum: 1 })),
    ),
    required_pass_fraction: Schema.Finite.pipe(
      Schema.check(Schema.isBetween({ minimum: 0.5, maximum: 1 })),
    ),
  }),
  retry_attempts: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 5 }))),
  vu_allocation: Schema.Struct({
    slo_multiple: Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
    minimum_vus: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  }),
  max_vus: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  calibration_rate_multiplier: Schema.Finite.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(1.5)),
  ),
  calibration_headroom: Schema.Struct({
    maximum_cpu_percent: Schema.Finite.pipe(
      Schema.check(Schema.isBetween({ minimum: 1, maximum: 95 })),
    ),
    maximum_throttled_fraction: Schema.Finite.pipe(
      Schema.check(Schema.isBetween({ minimum: 0, maximum: 0.05 })),
    ),
  }),
  mock_image: Schema.NonEmptyString.pipe(
    Schema.check(Schema.isPattern(/@sha256:[a-f0-9]{64}$/)),
  ),
  resources: Schema.Struct({
    cpus: Positive,
    memory: Schema.NonEmptyString,
    workers: Schema.Literal(1),
    idle_seconds: Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
    log_driver: Schema.NonEmptyString,
    mock_cpus: Positive,
    mock_memory: Schema.NonEmptyString,
    cpu_sets: Schema.Struct({ proxy: CpuSet, mock: CpuSet, load_generator: CpuSet }),
  }),
});

const ProxySubject = Schema.Struct({ image: Schema.NonEmptyString });
const Scenario = Schema.Struct({
  id: Schema.Literal("stream-arrival-sweep"),
  label: Schema.NonEmptyString,
  dimensions: Schema.Struct({
    arrival_rates: Schema.Array(Positive).pipe(Schema.check(Schema.isMinLength(3))),
    stream: Schema.Literal(true),
  }),
});

const cpuIds = (set: string): Set<number> =>
  new Set(
    set.split(",").flatMap((part) => {
      const [startText, endText] = part.split("-");
      const start = Number(startText);
      const end = Number(endText ?? startText);
      return Array.from({ length: end - start + 1 }, (_, index) => start + index);
    }),
  );

export const decodeStreamingChatRun = Effect.fn("ProxyStreamingChat.decodeConfig")(
  function*(context: RunContext) {
    const decoded = yield* Effect.all({
      config: Schema.decodeUnknownEffect(StreamingChatConfig, { onExcessProperty: "error" })(
        context.spec.job.config,
      ),
      subject: Schema.decodeUnknownEffect(ProxySubject, { onExcessProperty: "error" })(
        context.spec.artifact,
      ),
      scenarios: Schema.decodeUnknownEffect(Schema.Tuple([Scenario]), {
        onExcessProperty: "error",
      })(context.spec.benchmark.protocol.scenarios),
    }).pipe(Effect.mapError((error) => new InvalidRunnerConfig({ message: error.message })));
    const rates = [...decoded.config.arrival_rates];
    if (rates.some((rate, index) => index > 0 && rate <= rates[index - 1]!)) {
      return yield* new InvalidRunnerConfig({
        message: "arrival_rates must be strictly increasing",
      });
    }
    if (decoded.config.max_vus < decoded.config.vu_allocation.minimum_vus) {
      return yield* new InvalidRunnerConfig({
        message: "max_vus must be at least vu_allocation.minimum_vus",
      });
    }
    const requiredWarmup = decoded.config.steady_state.window_seconds
      * decoded.config.steady_state.windows;
    if (decoded.config.warmup_seconds < requiredWarmup) {
      return yield* new InvalidRunnerConfig({
        message: "warmup_seconds must contain every steady-state window",
      });
    }
    if (JSON.stringify(decoded.scenarios[0].dimensions.arrival_rates) !== JSON.stringify(rates)) {
      return yield* new InvalidRunnerConfig({
        message: "Declared scenario arrival rates do not match job configuration",
      });
    }
    const sets = Object.entries(decoded.config.resources.cpu_sets).map(([name, value]) =>
      [name, cpuIds(value)] as const
    );
    for (let left = 0; left < sets.length; left += 1) {
      for (let right = left + 1; right < sets.length; right += 1) {
        if ([...sets[left]![1]].some((cpu) => sets[right]![1].has(cpu))) {
          return yield* new InvalidRunnerConfig({
            message: `CPU sets ${sets[left]![0]} and ${sets[right]![0]} overlap`,
          });
        }
      }
    }
    return { config: decoded.config, subject: decoded.subject };
  },
);
