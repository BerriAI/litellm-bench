import { benchmarkData, staticBenchmarks } from "$lib/server/benchmarks";
import { error } from "@sveltejs/kit";
import type { EntryGenerator, PageServerLoad } from "./$types";

export const entries: EntryGenerator = async () =>
  (await staticBenchmarks()).map(({ id }) => ({ benchmarkId: id }));

export const load: PageServerLoad = async ({ params }) => {
  const data = await benchmarkData(params.benchmarkId);
  if (!data) error(404, "Benchmark not found");
  return data;
};
