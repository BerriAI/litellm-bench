import { error } from "@sveltejs/kit";
import { staticBenchmarks } from "../../lib/staticData";
import type { EntryGenerator, PageServerLoad } from "./$types";

export const entries: EntryGenerator = () =>
  staticBenchmarks().then((benchmarks) =>
    benchmarks.map((benchmark) => ({ benchmarkId: benchmark.id }))
  );

export const load: PageServerLoad = async ({ params }) => {
  const benchmark = (await staticBenchmarks()).find(({ id }) => id === params.benchmarkId);
  if (!benchmark) error(404, "Benchmark not found");
  return { benchmark };
};
