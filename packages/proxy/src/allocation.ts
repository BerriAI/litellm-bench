export interface VirtualUserAllocationPolicy {
  /** Multiple of the SLO-bounded concurrency (rate × SLO seconds) to pre-allocate. */
  readonly slo_multiple: number;
  /** Lower bound on pre-allocated VUs so tiny rates still tolerate service-time variance. */
  readonly minimum_vus: number;
  /** Hard ceiling on the VUs k6 may allocate for any trial. */
  readonly maximum_vus: number;
}

export interface VirtualUserAllocation {
  readonly preallocated_vus: number;
  readonly max_vus: number;
}

/**
 * Sizes the k6 VU pool for an open-model (`constant-arrival-rate`) trial the way the k6 docs
 * prescribe: `preAllocatedVUs ≈ rate × iteration duration + cushion`. The iteration duration is
 * bounded by the SLO a passing trial must satisfy, so a pool of `slo_multiple` times that
 * concurrency lets every SLO-compliant trial run without dropped iterations while a saturated
 * target surfaces as k6 `dropped_iterations` instead of an unbounded VU ramp on the load generator.
 * `maxVUs` keeps a single doubling of cushion so mid-run allocation stays bounded.
 */
export const allocateVirtualUsers = (
  rate: number,
  sloSeconds: number,
  policy: VirtualUserAllocationPolicy,
): VirtualUserAllocation => {
  const bounded = Math.ceil(rate * sloSeconds * policy.slo_multiple);
  const preallocated = Math.min(policy.maximum_vus, Math.max(policy.minimum_vus, bounded));
  return {
    preallocated_vus: preallocated,
    max_vus: Math.min(policy.maximum_vus, preallocated * 2),
  };
};
