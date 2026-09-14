export interface PackageVersion {
  readonly original: string;
  readonly release: readonly [string, string, string];
  readonly prerelease: "rc" | "dev" | null;
  readonly serial: string | null;
}

export interface SdkArtifact {
  readonly kind: "sdk";
  readonly requirement: string;
  readonly distribution: "litellm";
}

export interface ProxyArtifact {
  readonly kind: "proxy";
  readonly image: string;
}

export interface ResolvedRelease {
  readonly version: string;
  readonly sdk: SdkArtifact | null;
  readonly proxy: ProxyArtifact;
}

export interface PublishedRelease {
  readonly version: string;
  readonly publishedAt: string;
}

export type VersionResolution =
  | { readonly _tag: "Resolved"; readonly release: ResolvedRelease }
  | { readonly _tag: "InvalidVersion"; readonly input: string; readonly message: string };

interface DisplayVersion {
  readonly release: readonly [number, number, number];
  readonly prerelease: readonly (string | number)[];
}

const packagePattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:(rc|dev)(0|[1-9]\d*))?$/;
const tagPattern = /^v?([0-9]+\.[0-9]+\.[0-9]+)([A-Za-z0-9._-]*)$/;
const canonicalTagSuffix = /^[.-](rc|dev)\.?([0-9]+)$/;
const displayPattern = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:[-.]?(a|alpha|b|beta|rc)[.-]?(\d+))?$/i;
const semverPattern =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parsePackageVersion(input: string): PackageVersion | null {
  const match = packagePattern.exec(input);
  if (!match) return null;
  return {
    original: input,
    release: [match[1] as string, match[2] as string, match[3] as string],
    prerelease: match[4] as "rc" | "dev" | undefined ?? null,
    serial: match[5] ?? null,
  };
}

export function resolveVersion(input: string): VersionResolution {
  const packageVersion = parsePackageVersion(input);
  if (packageVersion) {
    const [major, minor, patch] = packageVersion.release;
    const release = `${major}.${minor}.${patch}`;
    const suffix = packageVersion.prerelease === null
      ? ""
      : `-${packageVersion.prerelease}.${packageVersion.serial}`;
    return {
      _tag: "Resolved",
      release: {
        version: input,
        sdk: { kind: "sdk", requirement: `litellm==${input}`, distribution: "litellm" },
        proxy: { kind: "proxy", image: `ghcr.io/berriai/litellm:v${release}${suffix}` },
      },
    };
  }

  const tag = tagPattern.exec(input);
  if (!tag) {
    return {
      _tag: "InvalidVersion",
      input,
      message: `invalid LiteLLM version or release tag ${JSON.stringify(input)}`,
    };
  }
  const releasePart = tag[1] as string;
  const suffix = tag[2] as string;
  const canonical = canonicalTagSuffix.exec(suffix);
  const mappedPackageVersion = canonical
    ? `${releasePart}${canonical[1]}${canonical[2]}`
    : releasePart;
  const hasSdk = suffix === "" || suffix === "-stable" || canonical !== null;
  return {
    _tag: "Resolved",
    release: {
      version: hasSdk ? mappedPackageVersion : input.replace(/^v/, ""),
      sdk: hasSdk
        ? { kind: "sdk", requirement: `litellm==${mappedPackageVersion}`, distribution: "litellm" }
        : null,
      proxy: { kind: "proxy", image: `ghcr.io/berriai/litellm:${input}` },
    },
  };
}

function parseDisplayVersion(input: string): DisplayVersion | null {
  const python = displayPattern.exec(input);
  if (python) {
    const stage = python[4]?.toLowerCase().replace(/^a$/, "alpha").replace(/^b$/, "beta");
    const numbers = [python[1], python[2], python[3] ?? "0", python[5] ?? "0"].map(Number);
    if (numbers.some((value) => !Number.isSafeInteger(value))) return null;
    return {
      release: [numbers[0] as number, numbers[1] as number, numbers[2] as number],
      prerelease: stage ? [stage, numbers[3] as number] : [],
    };
  }
  const semver = semverPattern.exec(input);
  if (!semver) return null;
  const release = [semver[1], semver[2], semver[3]].map(Number);
  if (release.some((value) => !Number.isSafeInteger(value))) return null;
  return {
    release: [release[0] as number, release[1] as number, release[2] as number],
    prerelease: semver[4]?.split(".").map((part) => /^\d+$/.test(part) ? Number(part) : part) ?? [],
  };
}

function compareIdentifiers(left: string | number, right: string | number): number {
  if (typeof left === "number" && typeof right === "number") return Math.sign(left - right);
  if (typeof left === "number") return -1;
  if (typeof right === "number") return 1;
  return left.localeCompare(right);
}

function compareParsed(left: DisplayVersion, right: DisplayVersion): number {
  const releaseDifference = left.release
    .map((value, index) => Math.sign(value - (right.release[index] as number)))
    .find((value) => value !== 0);
  if (releaseDifference !== undefined) return releaseDifference;
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0
      ? 1
      : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  return Array.from({ length }, (_, index) => {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    return compareIdentifiers(a, b);
  }).find((value) => value !== 0) ?? 0;
}

export function normalizedVersion(input: string): string | null {
  const parsed = parseDisplayVersion(input);
  if (!parsed) return null;
  const release = parsed.release.join(".");
  return parsed.prerelease.length === 0 ? release : `${release}-${parsed.prerelease.join(".")}`;
}

export function compareVersions(left: string, right: string): number {
  const a = parseDisplayVersion(left);
  const b = parseDisplayVersion(right);
  if (a && b) return compareParsed(a, b);
  if (a) return -1;
  if (b) return 1;
  return left.localeCompare(right, undefined, { numeric: true });
}

export function uniqueVersions(
  values: ReadonlyArray<string | null | undefined>,
): readonly string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort(
    compareVersions,
  );
}

export function publishedStableReleases(input: unknown): readonly PublishedRelease[] {
  if (typeof input !== "object" || input === null || !("releases" in input)) return [];
  const releases = (input as { readonly releases?: unknown }).releases;
  if (typeof releases !== "object" || releases === null || Array.isArray(releases)) return [];

  return Object.entries(releases).flatMap(([version, value]) => {
    const parsed = parsePackageVersion(version);
    if (parsed === null || parsed.prerelease !== null || !Array.isArray(value)) return [];
    const timestamps = value.flatMap((file): number[] => {
      if (typeof file !== "object" || file === null) return [];
      const fields = file as {
        readonly upload_time_iso_8601?: unknown;
        readonly yanked?: unknown;
      };
      if (fields.yanked === true || typeof fields.upload_time_iso_8601 !== "string") return [];
      const timestamp = Date.parse(fields.upload_time_iso_8601);
      return Number.isFinite(timestamp) ? [timestamp] : [];
    });
    if (timestamps.length === 0) return [];
    return [{ version, publishedAt: new Date(Math.min(...timestamps)).toISOString() }];
  }).sort((left, right) =>
    Date.parse(left.publishedAt) - Date.parse(right.publishedAt)
    || compareVersions(left.version, right.version)
  );
}
