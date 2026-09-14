import { writeFile } from "node:fs/promises";
import { canonicalOpenAiChatCompletions, openAiChatCompletionsFixture } from "../dist/index.js";

const common = {
  model: canonicalOpenAiChatCompletions.model,
  expectHeaders: canonicalOpenAiChatCompletions.headers,
  bodyMatch: "exact",
};
const document = (fixture) => ({
  $schema: "../../../schemas/current/upstream.schema.json",
  ...fixture,
});
const writeFixture = (name, fixture) =>
  writeFile(
    new URL(`../fixtures/${name}`, import.meta.url),
    `${JSON.stringify(document(fixture), null, 2)}\n`,
  );

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
      timing: { firstEventDelayMs: 10, eventIntervalMs: 1 },
    }),
  ),
]);
