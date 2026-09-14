import { readFile, writeFile } from "node:fs/promises";
import { canonicalMistralOcr, mistralOcrFixture } from "../dist/index.js";

const target = new URL("../fixtures/upstream.json", import.meta.url);
const fixture = mistralOcrFixture({
  id: "ocr",
  model: canonicalMistralOcr.model,
  markdown: canonicalMistralOcr.markdown,
  timing: { responseDelayMs: 0 },
});
const expected = `${
  JSON.stringify(
    {
      $schema: "../../../schemas/current/upstream.schema.json",
      ...fixture,
    },
    null,
    2,
  )
}\n`;

if (process.argv.includes("--check")) {
  const actual = await readFile(target, "utf8").catch(() => "");
  if (actual !== expected) throw new Error("stale generated fixture: upstream.json");
} else {
  await writeFile(target, expected);
}
