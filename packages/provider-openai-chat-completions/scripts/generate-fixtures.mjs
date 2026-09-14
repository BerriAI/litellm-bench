import { readFile, writeFile } from "node:fs/promises";
import {
  canonicalOpenAiChatCompletions,
  canonicalOpenAiChatCompletionsConformanceFixture,
  canonicalOpenAiStreamingMaxWriteBytes,
  openAiChatCompletionsFixture,
} from "../dist/index.js";

const common = {
  model: canonicalOpenAiChatCompletions.model,
  expectHeaders: canonicalOpenAiChatCompletions.headers,
  bodyMatch: "exact",
};
const document = (fixture) => ({
  $schema: "../../../schemas/current/upstream.schema.json",
  ...fixture,
});
const check = process.argv.includes("--check");
const writeFixture = async (name, fixture) => {
  const target = new URL(`../fixtures/${name}`, import.meta.url);
  const expected = `${JSON.stringify(document(fixture), null, 2)}\n`;
  if (!check) return writeFile(target, expected);
  const actual = await readFile(target, "utf8").catch(() => "");
  if (actual !== expected) throw new Error(`stale generated fixture: ${name}`);
};

await Promise.all([
  writeFixture(
    "nonstream.json",
    openAiChatCompletionsFixture({
      ...common,
      id: "nonstream-chat-completion",
      responseId: "chatcmpl-mock",
      expect: { messages: canonicalOpenAiChatCompletions.messages },
      chunks: [canonicalOpenAiChatCompletions.response],
      usage: canonicalOpenAiChatCompletions.usage,
      timing: { responseDelayMs: 0 },
    }),
  ),
  writeFixture(
    "streaming.json",
    openAiChatCompletionsFixture({
      ...common,
      id: "chat-stream",
      responseId: "chatcmpl-stream",
      expect: {
        messages: canonicalOpenAiChatCompletions.messages,
        stream_options: canonicalOpenAiChatCompletions.streamOptions,
      },
      chunks: canonicalOpenAiChatCompletions.streamingChunks,
      usage: canonicalOpenAiChatCompletions.usage,
      stream: true,
      includeUsage: true,
      maxWriteBytes: canonicalOpenAiStreamingMaxWriteBytes,
      timing: { firstEventDelayMs: 10, eventIntervalMs: 1 },
    }),
  ),
  writeFixture("conformance.json", canonicalOpenAiChatCompletionsConformanceFixture),
]);
