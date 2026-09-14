import { RunnerExecutionError } from "@litellm-bench/harness";
import { combinedSize, type FileSize } from "@litellm-bench/python-environment";
import { Context, Effect, FileSystem, Layer, Path } from "effect";

export interface PackageSizeProbeShape {
  readonly installedSize: (
    paths: readonly string[],
  ) => Effect.Effect<FileSize, RunnerExecutionError>;
}
export class PackageSizeProbe extends Context.Service<PackageSizeProbe, PackageSizeProbeShape>()(
  "@litellm-bench/benchmark-sdk-package-size/PackageSizeProbe",
) {}
export const PackageSizeProbeLive = Layer.effect(
  PackageSizeProbe,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return PackageSizeProbe.of({
      installedSize: (paths) =>
        combinedSize(paths).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError((error) => new RunnerExecutionError({ message: error.message })),
        ),
    });
  }),
);
