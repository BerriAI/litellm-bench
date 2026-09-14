import {
  AnnotationDocument,
  BenchmarkDefinition,
  BenchmarkIndex,
  BenchmarkResult,
  CommittedRecord,
  generateSchemaDocuments,
  RunSpec,
  UpstreamFixture,
} from "@litellm-bench/contracts";
import { Data, Effect, FileSystem, Path, Schema } from "effect";

export const DocumentKind = Schema.Literals([
  "annotations",
  "benchmark",
  "index",
  "result",
  "run-spec",
  "upstream",
  "record",
]);

export type DocumentKind = typeof DocumentKind.Type;

export class UnknownDocumentKind extends Data.TaggedError("UnknownDocumentKind")<{
  readonly message: string;
}> {}

export class SchemaFilesOutOfDate extends Data.TaggedError("SchemaFilesOutOfDate")<{
  readonly message: string;
  readonly count: number;
}> {}

const strict = { onExcessProperty: "error" } as const;
const decodeAnnotations = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AnnotationDocument),
  strict,
);
const decodeBenchmark = Schema.decodeUnknownEffect(
  Schema.fromJsonString(BenchmarkDefinition),
  strict,
);
const decodeIndex = Schema.decodeUnknownEffect(Schema.fromJsonString(BenchmarkIndex), strict);
const decodeResult = Schema.decodeUnknownEffect(Schema.fromJsonString(BenchmarkResult), strict);
const decodeRunSpec = Schema.decodeUnknownEffect(Schema.fromJsonString(RunSpec), strict);
const decodeUpstream = Schema.decodeUnknownEffect(Schema.fromJsonString(UpstreamFixture), strict);
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(CommittedRecord), strict);

const decodeDocument = (
  filePath: string,
  contents: string,
): Effect.Effect<DocumentKind, Schema.SchemaError | UnknownDocumentKind, Path.Path> =>
  Effect.gen(function*() {
    const path = yield* Path.Path;
    const name = path.basename(filePath);
    if (name === "annotations.json") {
      return yield* decodeAnnotations(contents).pipe(Effect.as("annotations" as const));
    }
    if (name === "benchmark.json") {
      return yield* decodeBenchmark(contents).pipe(Effect.as("benchmark" as const));
    }
    if (name === "index.json") {
      return yield* decodeIndex(contents).pipe(Effect.as("index" as const));
    }
    if (name === "benchmark-result.json") {
      return yield* decodeResult(contents).pipe(Effect.as("result" as const));
    }
    if (name === "benchmark-spec.json") {
      return yield* decodeRunSpec(contents).pipe(Effect.as("run-spec" as const));
    }
    if (name === "upstream.json") {
      return yield* decodeUpstream(contents).pipe(Effect.as("upstream" as const));
    }
    if (filePath.split(path.sep).includes("results")) {
      return yield* decodeRecord(contents).pipe(Effect.as("record" as const));
    }
    return yield* new UnknownDocumentKind({
      message: `cannot infer document kind from path: ${filePath}`,
    });
  });

export const validatePath = (filePath: string) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const contents = yield* fileSystem.readFileString(filePath, "utf8");
    return yield* decodeDocument(filePath, contents);
  });

export const writeSchemas = (output: string, check: boolean) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = Object.entries(generateSchemaDocuments()).map(([name, document]) =>
      [
        path.join(output, name),
        `${JSON.stringify(document, null, 2)}\n`,
      ] as const
    );

    if (check) {
      const mismatches = yield* Effect.all(
        entries.map(([filePath, expected]) =>
          fileSystem.readFileString(filePath, "utf8").pipe(
            Effect.map((actual) => actual === expected ? 0 : 1),
            Effect.catch(() => Effect.succeed(1)),
          )
        ),
        { concurrency: "unbounded" },
      );
      const count = mismatches.reduce((total, mismatch) => total + mismatch, 0);
      if (count > 0) {
        return yield* new SchemaFilesOutOfDate({
          count,
          message: `${count} generated schema file(s) are out of date`,
        });
      }
      return entries.length;
    }

    yield* fileSystem.makeDirectory(output, { recursive: true });
    yield* Effect.all(
      entries.map(([filePath, contents]) => fileSystem.writeFileString(filePath, contents)),
      { concurrency: "unbounded", discard: true },
    );
    return entries.length;
  });
