import { readFile, writeFile } from "node:fs/promises";
import { canonicalOpenAiResponse, openAiResponsesFixture } from "../dist/index.js";

const check = process.argv.includes("--check");
const writeFixture = async (name, fixture) => {
  const target = new URL(`../fixtures/${name}`, import.meta.url);
  const expected = `${
    JSON.stringify(
      { $schema: "../../../schemas/current/upstream.schema.json", ...fixture },
      null,
      2,
    )
  }\n`;
  if (!check) return writeFile(target, expected);
  const actual = await readFile(target, "utf8").catch(() => "");
  if (actual !== expected) throw new Error(`stale generated fixture: ${name}`);
};

await Promise.all([
  writeFixture(
    "nonstream.json",
    openAiResponsesFixture({
      id: "response",
      ...canonicalOpenAiResponse,
      timing: { responseDelayMs: 0 },
    }),
  ),
  writeFixture(
    "streaming.json",
    openAiResponsesFixture({
      id: "response-stream",
      ...canonicalOpenAiResponse,
      stream: true,
      timing: { firstEventDelayMs: 10, eventIntervalMs: 1 },
    }),
  ),
]);
