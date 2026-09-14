import { Schema } from "effect";

export const NonEmptyString = Schema.NonEmptyString;
export const FiniteNumber = Schema.Finite;
export const NonNegativeInteger = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
export const PositiveInteger = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)));
export const JsonObject = Schema.JsonObject;
export const JsonValue = Schema.Json;
export const Better = Schema.Literals(["higher", "lower", "neutral"]);

export const Timestamp = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
      { expected: "an RFC 3339 timestamp with a UTC or numeric offset", format: "date-time" },
    ),
  ),
);

export const Sha256Id = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/, { expected: "a lowercase SHA-256 digest" })),
);

export const HttpUrl = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^https?:\/\/[^\s]+$/, { expected: "an HTTP or HTTPS URL", format: "uri" }),
  ),
);

export const decodeStrict = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" });

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type Json = typeof JsonValue.Type;
export type JsonRecord = typeof JsonObject.Type;
