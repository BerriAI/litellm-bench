import { describe, expect, it } from "vitest";
import { allocateVirtualUsers } from "./allocation.js";

const policy = { slo_multiple: 4, minimum_vus: 16, maximum_vus: 512 };

describe("k6 virtual-user allocation", () => {
  it("pre-allocates enough VUs for the offered rate at the SLO with the configured multiple", () => {
    // Little's law: 80 iterations/s × 0.2 s = 16 concurrent iterations; ×4 leaves headroom.
    expect(allocateVirtualUsers(80, 0.2, policy)).toEqual({ preallocated_vus: 64, max_vus: 128 });
    expect(allocateVirtualUsers(675, 0.1, policy)).toEqual({ preallocated_vus: 270, max_vus: 512 });
  });

  it("rounds fractional demand up so k6 never schedules more iterations than VUs", () => {
    expect(allocateVirtualUsers(25, 0.2, { ...policy, minimum_vus: 1 }).preallocated_vus).toBe(20);
    expect(allocateVirtualUsers(7, 0.1, { ...policy, minimum_vus: 1 }).preallocated_vus).toBe(3);
  });

  it("never drops below the minimum or above the maximum pool", () => {
    expect(allocateVirtualUsers(1, 0.1, policy)).toEqual({ preallocated_vus: 16, max_vus: 32 });
    expect(allocateVirtualUsers(10_000, 1, policy)).toEqual({
      preallocated_vus: 512,
      max_vus: 512,
    });
  });

  it("keeps max_vus bounded so k6 cannot ramp an unbounded pool on the load generator", () => {
    const allocation = allocateVirtualUsers(100, 0.5, policy);
    expect(allocation.max_vus).toBe(Math.min(512, allocation.preallocated_vus * 2));
    expect(allocation.max_vus).toBeGreaterThanOrEqual(allocation.preallocated_vus);
  });
});
