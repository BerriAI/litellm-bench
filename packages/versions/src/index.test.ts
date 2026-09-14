import assert from "node:assert/strict";
import test from "node:test";
import {
  compareVersions,
  normalizedVersion,
  parsePackageVersion,
  publishedStableReleases,
  resolveVersion,
  uniqueVersions,
} from "./index.js";

test("maps package prereleases to exact SDK and image artifact names", () => {
  assert.deepEqual(parsePackageVersion("1.102.0rc1"), {
    original: "1.102.0rc1",
    release: ["1", "102", "0"],
    prerelease: "rc",
    serial: "1",
  });
  assert.deepEqual(resolveVersion("1.102.0rc1"), {
    _tag: "Resolved",
    release: {
      version: "1.102.0rc1",
      sdk: { kind: "sdk", requirement: "litellm==1.102.0rc1", distribution: "litellm" },
      proxy: { kind: "proxy", image: "ghcr.io/berriai/litellm:v1.102.0-rc.1" },
    },
  });
});

test("extracts dated, non-yanked stable releases from PyPI metadata", () => {
  assert.deepEqual(
    publishedStableReleases({
      releases: {
        "1.2.0": [
          { upload_time_iso_8601: "2026-01-02T12:00:00Z", yanked: false },
          { upload_time_iso_8601: "2026-01-02T12:01:00Z", yanked: false },
        ],
        "1.3.0rc1": [{ upload_time_iso_8601: "2026-02-01T12:00:00Z", yanked: false }],
        "1.3.0": [{ upload_time_iso_8601: "2026-02-02T12:00:00Z", yanked: true }],
        "1.4.0": [{ upload_time_iso_8601: "not-a-date", yanked: false }],
        "1.1.0": [{ upload_time_iso_8601: "2026-01-01T12:00:00Z", yanked: false }],
      },
    }),
    [
      { version: "1.1.0", publishedAt: "2026-01-01T12:00:00.000Z" },
      { version: "1.2.0", publishedAt: "2026-01-02T12:00:00.000Z" },
    ],
  );
  assert.deepEqual(publishedStableReleases(null), []);
});

test("retains opaque image tags and only supplies safe package mappings", () => {
  const stable = resolveVersion("v1.2.3-stable");
  assert.equal(stable._tag, "Resolved");
  if (stable._tag === "Resolved") {
    assert.equal(stable.release.sdk?.requirement, "litellm==1.2.3");
    assert.equal(stable.release.proxy.image, "ghcr.io/berriai/litellm:v1.2.3-stable");
  }
  const opaque = resolveVersion("v1.2.3-nightly.7");
  assert.equal(opaque._tag, "Resolved");
  if (opaque._tag === "Resolved") assert.equal(opaque.release.sdk, null);
  assert.equal(resolveVersion("garbage")._tag, "InvalidVersion");
  const huge = resolveVersion("999999999999999999999.2.3rc4");
  assert.equal(huge._tag, "Resolved");
  if (huge._tag === "Resolved") {
    assert.equal(
      huge.release.proxy.image,
      "ghcr.io/berriai/litellm:v999999999999999999999.2.3-rc.4",
    );
  }
});

test("orders Python-style, SemVer, and opaque display versions without conflating them", () => {
  assert.equal(normalizedVersion("v1.2rc3"), "1.2.0-rc.3");
  assert.ok(compareVersions("1.2.0-rc.3", "1.2.0") < 0);
  assert.deepEqual(uniqueVersions(["legacy-10", "1.2", "1.2.0", null, "legacy-2", "1.2"]), [
    "1.2",
    "1.2.0",
    "legacy-2",
    "legacy-10",
  ]);
});
