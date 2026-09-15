import { HostEnvironmentSnapshot } from "@litellm-bench/contracts/metadata";
import { Schema } from "effect";
import { expect, it } from "vitest";

import { captureHostEnvironment } from "../src/index.js";

it("records machine resources that can bias timing measurements", () => {
  const snapshot = captureHostEnvironment({}, "linux", "x64");
  expect(snapshot).toMatchObject({
    platform: "linux",
    architecture: "x86_64",
    host: "existing",
    ci: false,
  });
  expect(snapshot.cpu_count).toBeGreaterThan(0);
  expect(snapshot.memory_total_bytes).toBeGreaterThan(0);
  expect(snapshot.kernel_release).not.toBe("");
  expect(Schema.decodeUnknownSync(HostEnvironmentSnapshot)(snapshot)).toEqual(snapshot);
});
