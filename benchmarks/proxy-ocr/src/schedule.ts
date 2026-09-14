import { seededUint32 } from "./random.js";
import type { OcrScenario, OcrVariant } from "./types.js";

const shuffled = <T>(values: readonly T[], seed: string): T[] => {
  const output = [...values];
  const next = seededUint32(seed);
  for (let index = output.length - 1; index > 0; index -= 1) {
    const target = next() % (index + 1);
    [output[index], output[target]] = [output[target]!, output[index]!];
  }
  return output;
};

export interface ScheduledTrial {
  readonly scenario: OcrScenario;
  readonly variant: OcrVariant;
  readonly round: number;
}

export const trialSchedule = (
  scenarios: readonly OcrScenario[],
  rounds: number,
  seed = "proxy-ocr-v1",
): readonly ScheduledTrial[] =>
  Array.from({ length: rounds }, (_, index) => index + 1).flatMap((round) =>
    shuffled(scenarios, `${seed}:round:${round}`).flatMap((scenario) =>
      shuffled<OcrVariant>(["python", "rust"], `${seed}:round:${round}:${scenario.id}`)
        .map((variant) => ({ scenario, variant, round }))
    )
  );
