import { createHash } from "node:crypto";

export const seededUint32 = (seed: string): () => number => {
  let state = Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16);
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
};
