import {
  BenchmarkDefinition,
  type BenchmarkDefinition as BenchmarkDefinitionType,
  validateBenchmarkDefinition,
} from "@litellm-bench/contracts/metadata";
import { Effect, FileSystem, Path, Schema } from "effect";

import { type BenchmarkCatalog, buildCatalog, type CatalogIssue } from "./model.js";

export class CatalogGenerationError extends Error {
  readonly issues: readonly CatalogIssue[];

  constructor(issues: readonly CatalogIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    this.name = "CatalogGenerationError";
    this.issues = issues;
  }
}

function formatCatalog(catalog: BenchmarkCatalog): string {
  return `import type { BenchmarkCatalog } from "./model.js";\n\nexport const benchmarkCatalog = ${
    JSON.stringify(catalog, null, 2)
  } as const satisfies BenchmarkCatalog;\n`;
}

function parseDefinition(path: string, value: unknown): BenchmarkDefinitionType {
  try {
    return Schema.decodeUnknownSync(BenchmarkDefinition, { onExcessProperty: "error" })(value);
  } catch (error) {
    throw new CatalogGenerationError([{ path, message: String(error) }]);
  }
}

export function renderCatalog(
  benchmarksDirectory: string,
): Effect.Effect<
  string,
  CatalogGenerationError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const children = (yield* fs.readDirectory(benchmarksDirectory))
      .filter((name) => !name.startsWith("_"));
    const inspected = yield* Effect.forEach(
      children,
      (name) =>
        fs.stat(pathService.join(benchmarksDirectory, name)).pipe(
          Effect.map((info) => ({ name, isDirectory: info.type === "Directory" })),
        ),
      { concurrency: "unbounded" },
    );
    const entries = inspected.filter(({ isDirectory }) => isDirectory)
      .map(({ name }) => name)
      .toSorted((left, right) => left.localeCompare(right));
    const decoded = yield* Effect.forEach(entries, (name) =>
      Effect.gen(function*() {
        const path = pathService.join(benchmarksDirectory, name, "benchmark.json");
        const contents = yield* fs.readFileString(path);
        const definition = yield* Effect.try({
          try: () => parseDefinition(path, JSON.parse(contents) as unknown),
          catch: (error) => error,
        });
        const semanticIssues = validateBenchmarkDefinition(definition);
        if (semanticIssues.length) {
          return yield* Effect.fail(
            new CatalogGenerationError(semanticIssues.map((issue) => ({
              path: `${name}/benchmark.json.${issue.path}`,
              message: issue.message,
            }))),
          );
        }
        return { directory: pathService.basename(name), definition };
      }), { concurrency: "unbounded" });
    const catalog = buildCatalog(decoded);
    if (catalog._tag === "InvalidCatalog") {
      return yield* Effect.fail(new CatalogGenerationError(catalog.issues));
    }
    return formatCatalog(catalog.value);
  }).pipe(
    Effect.mapError((error) =>
      error instanceof CatalogGenerationError
        ? error
        : new CatalogGenerationError([{ path: benchmarksDirectory, message: String(error) }])
    ),
  );
}

export function generateCatalog(
  benchmarksDirectory: string,
  outputPath: string,
): Effect.Effect<void, CatalogGenerationError, FileSystem.FileSystem | Path.Path> {
  return Effect.flatMap(
    renderCatalog(benchmarksDirectory),
    (contents) =>
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(outputPath, contents)).pipe(
        Effect.mapError((error) =>
          new CatalogGenerationError([{ path: outputPath, message: String(error) }])
        ),
      ),
  );
}
