import { InvalidObservation } from "@litellm-bench/harness";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import type { OcrObservation } from "./types.js";

export interface OcrArtifactsShape {
  readonly writeRows: (
    directory: string,
    rows: readonly OcrObservation[],
  ) => Effect.Effect<void, InvalidObservation>;
}
export class OcrArtifacts extends Context.Service<OcrArtifacts, OcrArtifactsShape>()(
  "@litellm-bench/benchmark-proxy-ocr/OcrArtifacts",
) {}
export const OcrArtifactsLive = Layer.effect(
  OcrArtifacts,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return OcrArtifacts.of({
      writeRows: (directory, rows) =>
        fs.writeFileString(
          path.join(directory, "primary.jsonl"),
          `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
        ).pipe(
          Effect.mapError((error) =>
            new InvalidObservation({ message: `Cannot write OCR primary rows: ${error.message}` })
          ),
        ),
    });
  }),
);
