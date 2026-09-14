import { type NumericSummary, summarize } from "./index.js";

export interface Pair<T> {
  readonly key: string;
  readonly left: T;
  readonly right: T;
}

export type PairingResult<T> =
  | { readonly _tag: "Paired"; readonly pairs: readonly Pair<T>[] }
  | { readonly _tag: "DuplicateKey"; readonly side: "left" | "right"; readonly key: string }
  | {
    readonly _tag: "UnmatchedKeys";
    readonly leftOnly: readonly string[];
    readonly rightOnly: readonly string[];
  };

export interface PairedRatios<T> {
  readonly pairs: readonly (Pair<T> & { readonly ratio: number })[];
  readonly summary: NumericSummary;
  readonly leftWins: number;
  readonly rightWins: number;
  readonly ties: number;
}

type IndexResult<T> =
  | { readonly _tag: "Indexed"; readonly values: ReadonlyMap<string, T> }
  | { readonly _tag: "DuplicateKey"; readonly side: "left" | "right"; readonly key: string };

function indexUnique<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  side: "left" | "right",
): IndexResult<T> {
  const entries = values.map((value) => [keyOf(value), value] as const);
  const duplicate = entries.find(([key], index) =>
    entries.findIndex(([candidate]) => candidate === key) !== index
  );
  return duplicate
    ? { _tag: "DuplicateKey", side, key: duplicate[0] }
    : { _tag: "Indexed", values: new Map(entries) };
}

export function pairBy<T>(
  left: readonly T[],
  right: readonly T[],
  keyOf: (value: T) => string,
): PairingResult<T> {
  const leftIndex = indexUnique(left, keyOf, "left");
  if (leftIndex._tag === "DuplicateKey") return leftIndex;
  const rightIndex = indexUnique(right, keyOf, "right");
  if (rightIndex._tag === "DuplicateKey") return rightIndex;
  const leftOnly = [...leftIndex.values.keys()].filter((key) => !rightIndex.values.has(key)).sort();
  const rightOnly = [...rightIndex.values.keys()].filter((key) => !leftIndex.values.has(key))
    .sort();
  if (leftOnly.length || rightOnly.length) return { _tag: "UnmatchedKeys", leftOnly, rightOnly };
  return {
    _tag: "Paired",
    pairs: [...leftIndex.values].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({
      key,
      left: value,
      right: rightIndex.values.get(key) as T,
    })),
  };
}

export type RatioResult<T> =
  | { readonly _tag: "Ratios"; readonly value: PairedRatios<T> }
  | Exclude<PairingResult<T>, { readonly _tag: "Paired" }>
  | { readonly _tag: "InvalidDenominator"; readonly key: string; readonly value: number };

export function pairedRatios<T>(
  left: readonly T[],
  right: readonly T[],
  keyOf: (value: T) => string,
  valueOf: (value: T) => number,
): RatioResult<T> {
  const paired = pairBy(left, right, keyOf);
  if (paired._tag !== "Paired") return paired;
  const invalid = paired.pairs.find((pair) =>
    !Number.isFinite(valueOf(pair.left)) || valueOf(pair.left) === 0
  );
  if (invalid) {
    return { _tag: "InvalidDenominator", key: invalid.key, value: valueOf(invalid.left) };
  }
  const pairs = paired.pairs.map((pair) => ({
    ...pair,
    ratio: valueOf(pair.right) / valueOf(pair.left),
  }));
  const ratioSummary = summarize(pairs.map((pair) => pair.ratio));
  if (ratioSummary._tag === "NoFiniteValues") {
    return { _tag: "InvalidDenominator", key: pairs[0]?.key ?? "", value: Number.NaN };
  }
  return {
    _tag: "Ratios",
    value: {
      pairs,
      summary: ratioSummary.value,
      leftWins: pairs.filter((pair) => pair.ratio < 1).length,
      rightWins: pairs.filter((pair) => pair.ratio > 1).length,
      ties: pairs.filter((pair) => pair.ratio === 1).length,
    },
  };
}
