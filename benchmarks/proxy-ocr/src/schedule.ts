import { createHash } from "node:crypto";
import type { OcrScenario, OcrVariant } from "./types.js";

const shuffled = <T>(values: readonly T[], seed: string): T[] => {
  const output = [...values];
  let state = Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16);
  for (let index = output.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const target = state % (index + 1);
    [output[index], output[target]] = [output[target]!, output[index]!];
  }
  return output;
};

export const trialSchedule = (
  scenarios: readonly OcrScenario[],
  rounds: number,
  seed = "proxy-ocr-v1",
): readonly (readonly [OcrScenario, OcrVariant, number])[] =>
  Array.from({ length: rounds }, (_, index) => index + 1).flatMap((round) =>
    shuffled(scenarios, `${seed}:round:${round}`).flatMap((scenario) =>
      shuffled<OcrVariant>(["python", "rust"], `${seed}:round:${round}:${scenario.id}`)
        .map((variant) => [scenario, variant, round] as const)
    )
  );
