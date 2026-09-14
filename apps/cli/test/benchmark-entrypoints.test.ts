import * as chatCompletions from "@litellm-bench/benchmark-proxy-chat-completions";
import * as streamingChatCompletions from "@litellm-bench/benchmark-proxy-chat-completions-streaming";
import * as ocr from "@litellm-bench/benchmark-proxy-ocr";
import * as importFootprint from "@litellm-bench/benchmark-sdk-import-footprint";
import * as importTime from "@litellm-bench/benchmark-sdk-import-time";
import * as packageSize from "@litellm-bench/benchmark-sdk-package-size";
import { expect, it } from "vitest";

it.each([
  ["proxy-chat-completions", chatCompletions],
  ["proxy-chat-completions-streaming", streamingChatCompletions],
  ["proxy-ocr", ocr],
  ["sdk-import-footprint", importFootprint],
  ["sdk-import-time", importTime],
  ["sdk-package-size", packageSize],
])("exposes only the %s runner", (_name, entrypoint) => {
  expect(Object.keys(entrypoint)).toEqual(["runner"]);
});
