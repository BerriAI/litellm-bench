import { staticBenchmarks } from "$lib/server/benchmarks";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => ({
  benchmarks: await staticBenchmarks(),
});
