import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  IMAGE_GENERATION_TOOL_NAME,
  createImageGenerationTool,
  rewriteNativeImageGenerationTool,
  rewriteNativeWebSearchTool,
  supportsNativeImageGeneration,
} from "./native-tools.ts";
import registerOpenAINativeCompaction from "./compaction/index.ts";
import { buildCodexSystemPrompt } from "./prompt.ts";

function isCodexModel(model: ExtensionContext["model"] | undefined): boolean {
  const provider = model?.provider?.toLowerCase() ?? "";
  const id = model?.id?.toLowerCase() ?? "";
  return provider.includes("codex") || id.includes("codex");
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export default function codexNativeExtension(pi: ExtensionAPI) {
  registerOpenAINativeCompaction(pi);
  pi.registerTool(createImageGenerationTool());

  const applyToolPolicy = (ctx?: ExtensionContext) => {
    if (!ctx) return;
    const active = pi.getActiveTools();
    const codexModel = isCodexModel(ctx.model);
    let next = active;

    if (
      codexModel &&
      supportsNativeImageGeneration(ctx.model) &&
      !next.includes(IMAGE_GENERATION_TOOL_NAME)
    ) {
      next = [...next, IMAGE_GENERATION_TOOL_NAME];
    }

    if (!codexModel && next.includes(IMAGE_GENERATION_TOOL_NAME)) {
      next = next.filter((toolName) => toolName !== IMAGE_GENERATION_TOOL_NAME);
    }

    if (!arraysEqual(active, next)) pi.setActiveTools(next);
  };

  pi.on("session_start", (_event, ctx) => {
    applyToolPolicy(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    applyToolPolicy(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    applyToolPolicy(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    applyToolPolicy(ctx);
    if (!isCodexModel(ctx.model)) return;
    const systemPrompt = buildCodexSystemPrompt(event.systemPrompt);
    if (systemPrompt !== event.systemPrompt) return { systemPrompt };
  });

  pi.on("before_provider_request", async (event, ctx) =>
    rewriteNativeImageGenerationTool(
      rewriteNativeWebSearchTool(event.payload, ctx.model),
      ctx.model,
    ),
  );
}
