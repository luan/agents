import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getOpenAICodexLatestImagePath,
  rewriteNativeImageGenerationTool,
  rewriteNativeWebSearchTool,
  saveOpenAICodexGeneratedImage,
} from "./native-tools.ts";

const codexModel = {
  provider: "openai-codex",
  id: "gpt-5.5",
  input: ["text", "image"],
};

test("rewrites Codex web_search function tool to native Responses tool", () => {
  const payload = {
    model: "gpt-5.5",
    input: [],
    tools: [
      { type: "function", name: "web_search", parameters: {} },
      { type: "function", name: "apply_patch", parameters: {} },
    ],
  };

  const rewritten = rewriteNativeWebSearchTool(
    payload,
    codexModel as never,
  ) as typeof payload;
  expect(rewritten.tools[0]).toEqual({
    type: "web_search",
    external_web_access: true,
    search_content_types: ["text", "image"],
  });
  expect(rewritten.tools[1]).toEqual(payload.tools[1]);
});

test("rewrites image_generation only for image-capable openai-codex models", () => {
  const payload = {
    model: "gpt-5.5",
    input: [],
    tools: [{ type: "function", name: "image_generation", parameters: {} }],
  };

  const rewritten = rewriteNativeImageGenerationTool(
    payload,
    codexModel as never,
  ) as typeof payload;
  expect(rewritten.tools[0]).toEqual({
    type: "image_generation",
    output_format: "png",
  });

  const textOnly = rewriteNativeImageGenerationTool(payload, {
    ...codexModel,
    input: ["text"],
  } as never) as typeof payload;
  expect(textOnly.tools[0]).toEqual(payload.tools[0]);
});

test("saves generated images under workspace .pi directory and mirrors latest", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-native-test-"));
  await mkdir(join(root, ".git"));
  const imageData = Buffer.from("fake-png").toString("base64");

  const saved = await saveOpenAICodexGeneratedImage(root, {
    responseId: "resp_123456789",
    callId: "call_abcdef",
    result: imageData,
    outputFormat: "png",
  });

  expect(saved.relativePath.startsWith(".pi/openai-codex-images/")).toBe(true);
  expect(saved.latestRelativePath).toBe(".pi/openai-codex-images/latest.png");
  expect(await readFile(saved.absolutePath, "utf8")).toBe("fake-png");
  expect(await readFile(getOpenAICodexLatestImagePath(root), "utf8")).toBe(
    "fake-png",
  );
});
