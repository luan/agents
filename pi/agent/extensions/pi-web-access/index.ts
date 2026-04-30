import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

const WEB_SEARCH_CONFIG_PATH = join(homedir(), ".pi", "web-search.json");
const DEFAULT_SHORTCUTS = { curate: "ctrl+shift+s", activity: "ctrl+shift+w" };

type CapturedRuntime = {
  tools: Map<string, any>;
  commands: Map<string, any>;
  shortcuts: Map<string, any>;
  handlers: Map<string, Array<(event: any, ctx: any) => unknown>>;
  sessionStarted: boolean;
};

let runtimePromise: Promise<CapturedRuntime> | null = null;
let loadedRuntime: CapturedRuntime | null = null;

function loadShortcutConfig(): { curate: string; activity: string } {
  if (!existsSync(WEB_SEARCH_CONFIG_PATH)) return DEFAULT_SHORTCUTS;
  try {
    const config = JSON.parse(
      readFileSync(WEB_SEARCH_CONFIG_PATH, "utf-8"),
    ) as {
      shortcuts?: { curate?: unknown; activity?: unknown };
    };
    return {
      curate:
        typeof config.shortcuts?.curate === "string"
          ? config.shortcuts.curate
          : DEFAULT_SHORTCUTS.curate,
      activity:
        typeof config.shortcuts?.activity === "string"
          ? config.shortcuts.activity
          : DEFAULT_SHORTCUTS.activity,
    };
  } catch {
    return DEFAULT_SHORTCUTS;
  }
}

function captureApi(pi: ExtensionAPI, runtime: CapturedRuntime): ExtensionAPI {
  return {
    on(event: string, handler: (event: any, ctx: any) => unknown) {
      const handlers = runtime.handlers.get(event) ?? [];
      handlers.push(handler);
      runtime.handlers.set(event, handlers);
    },
    registerTool(tool: any) {
      runtime.tools.set(tool.name, tool);
    },
    registerCommand(name: string, options: any) {
      runtime.commands.set(name, options);
    },
    registerShortcut(shortcut: string, options: any) {
      runtime.shortcuts.set(shortcut, options);
    },
    registerFlag(name: string, options: any) {
      pi.registerFlag(name, options);
    },
    registerMessageRenderer(customType: string, renderer: any) {
      pi.registerMessageRenderer(customType, renderer);
    },
    sendMessage: (message: any, options?: any) =>
      pi.sendMessage(message, options),
    sendUserMessage: (content: any, options?: any) =>
      pi.sendUserMessage(content, options),
    appendEntry: (customType: string, data?: any) =>
      pi.appendEntry(customType, data),
    setSessionName: (name: string | undefined) => pi.setSessionName(name),
    getSessionName: () => pi.getSessionName(),
    setLabel: (entryId: string, label: string | undefined) =>
      pi.setLabel(entryId, label),
    exec: (command: string, args: string[], options?: any) =>
      pi.exec(command, args, options),
    getActiveTools: () => pi.getActiveTools(),
    getAllTools: () => pi.getAllTools(),
    setActiveTools: (toolNames: string[]) => pi.setActiveTools(toolNames),
    getCommands: () => pi.getCommands(),
    setModel: (model: any) => pi.setModel(model),
    getThinkingLevel: () => pi.getThinkingLevel(),
    setThinkingLevel: (level: any) => pi.setThinkingLevel(level),
    registerProvider: (name: string, config: any) =>
      pi.registerProvider(name, config),
    unregisterProvider: (name: string) => pi.unregisterProvider(name),
    events: pi.events,
  } as ExtensionAPI;
}

async function ensureRuntime(
  pi: ExtensionAPI,
  ctx?: ExtensionContext,
): Promise<CapturedRuntime> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const runtime: CapturedRuntime = {
        tools: new Map(),
        commands: new Map(),
        shortcuts: new Map(),
        handlers: new Map(),
        sessionStarted: false,
      };
      const mod = await import("./full.js");
      await mod.default(captureApi(pi, runtime));
      loadedRuntime = runtime;
      return runtime;
    })();
  }

  const runtime = await runtimePromise;
  if (ctx && !runtime.sessionStarted) {
    runtime.sessionStarted = true;
    await runHandlers(runtime, "session_start", { reason: "startup" }, ctx);
  }
  return runtime;
}

async function runHandlers(
  runtime: CapturedRuntime,
  event: string,
  payload: any,
  ctx: ExtensionContext,
) {
  for (const handler of runtime.handlers.get(event) ?? []) {
    await handler(payload, ctx);
  }
}

function toolResultRenderer(name: string) {
  return (result: any, options: any, theme: any, ctx: any) => {
    const renderer = loadedRuntime?.tools.get(name)?.renderResult;
    const component = renderer?.(result, options, theme, ctx);
    if (isComponent(component)) return component;
    return new Text(formatFallbackResult(result), 0, 0);
  };
}

function toolCallRenderer(label: string, name: string) {
  return (args: any, theme: any, ctx: any) => {
    const renderer = loadedRuntime?.tools.get(name)?.renderCall;
    const component = renderer?.(args, theme, ctx);
    if (isComponent(component)) return component;
    return new Text(theme.fg("toolTitle", theme.bold(label)), 0, 0);
  };
}

function isComponent(
  value: unknown,
): value is { render(width: number): string[] } {
  return (
    !!value && typeof (value as { render?: unknown }).render === "function"
  );
}

function formatFallbackResult(result: any): string {
  const text = result?.content?.find?.(
    (block: any) => block?.type === "text",
  )?.text;
  if (typeof text !== "string" || !text.trim()) return "(renderer loading)";
  const lines = text.trim().split("\n");
  const preview = lines.slice(0, 20).join("\n");
  return lines.length > 20
    ? `${preview}\n… ${lines.length - 20} more lines`
    : preview;
}

function registerLazyTool(pi: ExtensionAPI, name: string, definition: any) {
  pi.registerTool({
    ...definition,
    async execute(
      toolCallId: string,
      params: any,
      signal: AbortSignal | undefined,
      onUpdate: any,
      ctx: ExtensionContext,
    ) {
      const runtime = await ensureRuntime(pi, ctx);
      const tool = runtime.tools.get(name);
      if (!tool)
        throw new Error(
          `pi-web-access internal error: ${name} did not register.`,
        );
      return tool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall: toolCallRenderer(definition.label ?? name, name),
    renderResult: toolResultRenderer(name),
  });
}

export default function piWebAccess(pi: ExtensionAPI) {
  registerLazyTool(pi, "web_search", {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using Perplexity AI, Exa, or Gemini. Returns an AI-synthesized answer with source citations.",
    promptSnippet:
      "Use for web research questions. Prefer {queries:[...]} with 2-4 varied angles over a single query for broader coverage.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            "Single search query. For research tasks, prefer 'queries' with multiple varied angles instead.",
        }),
      ),
      queries: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Multiple queries searched in sequence, each returning its own synthesized answer.",
        }),
      ),
      numResults: Type.Optional(
        Type.Number({ description: "Results per query (default: 5, max: 20)" }),
      ),
      includeContent: Type.Optional(
        Type.Boolean({ description: "Fetch full page content (async)" }),
      ),
      recencyFilter: Type.Optional(
        StringEnum(["day", "week", "month", "year"], {
          description: "Filter by recency",
        }),
      ),
      domainFilter: Type.Optional(
        Type.Array(Type.String(), {
          description: "Limit to domains (prefix with - to exclude)",
        }),
      ),
      provider: Type.Optional(
        StringEnum(["auto", "perplexity", "gemini", "exa"], {
          description: "Search provider (default: auto)",
        }),
      ),
      workflow: Type.Optional(
        StringEnum(["none", "summary-review"], {
          description:
            "Search workflow mode: none = no curator, summary-review = open curator",
        }),
      ),
    }),
  });

  registerLazyTool(pi, "code_search", {
    name: "code_search",
    label: "Code Search",
    description: "Search for code examples, documentation, and API references.",
    promptSnippet:
      "Use for programming/API/library questions to retrieve concrete examples and docs before implementing or debugging code.",
    parameters: Type.Object({
      query: Type.String({
        description:
          "Programming question, API, library, or debugging topic to search for",
      }),
      maxTokens: Type.Optional(
        Type.Number({
          description:
            "Maximum tokens of code/documentation context to return (default: 5000)",
        }),
      ),
    }),
  });

  registerLazyTool(pi, "fetch_content", {
    name: "fetch_content",
    label: "Fetch Content",
    description:
      "Fetch URL(s) and extract readable content as markdown. Supports GitHub repos, PDFs, YouTube videos, and local video files.",
    promptSnippet:
      "Use to extract readable content from URL(s), YouTube, GitHub repos, or local videos.",
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "Single URL to fetch" })),
      urls: Type.Optional(
        Type.Array(Type.String(), { description: "Multiple URLs (parallel)" }),
      ),
      forceClone: Type.Optional(
        Type.Boolean({
          description:
            "Force cloning large GitHub repositories that exceed the size threshold",
        }),
      ),
      prompt: Type.Optional(
        Type.String({
          description: "Question or instruction for video analysis",
        }),
      ),
      timestamp: Type.Optional(
        Type.String({
          description: "Extract video frame(s) at a timestamp or time range",
        }),
      ),
      frames: Type.Optional(
        Type.Number({ description: "Number of frames to extract" }),
      ),
      model: Type.Optional(
        Type.String({
          description: "Override the Gemini model for video/YouTube analysis",
        }),
      ),
    }),
  });

  registerLazyTool(pi, "get_search_content", {
    name: "get_search_content",
    label: "Get Search Content",
    description:
      "Retrieve full content from a previous web_search or fetch_content call.",
    promptSnippet:
      "Use after web_search/fetch_content when full stored content is needed via responseId plus query/url selectors.",
    parameters: Type.Object({
      responseId: Type.String({
        description: "The responseId from web_search or fetch_content",
      }),
      query: Type.Optional(
        Type.String({ description: "Get content for this query (web_search)" }),
      ),
      queryIndex: Type.Optional(
        Type.Number({ description: "Get content for query at index" }),
      ),
      url: Type.Optional(
        Type.String({ description: "Get content for this URL" }),
      ),
      urlIndex: Type.Optional(
        Type.Number({ description: "Get content for URL at index" }),
      ),
    }),
  });

  for (const name of ["websearch", "curator", "google-account", "search"]) {
    pi.registerCommand(name, {
      description:
        name === "websearch"
          ? "Open web search curator"
          : `pi-web-access ${name}`,
      handler: async (args, ctx) => {
        const runtime = await ensureRuntime(pi, ctx);
        const command = runtime.commands.get(name);
        if (!command)
          throw new Error(
            `pi-web-access internal error: /${name} did not register.`,
          );
        return command.handler(args, ctx);
      },
    });
  }

  const shortcuts = loadShortcutConfig();
  for (const shortcut of [shortcuts.curate, shortcuts.activity]) {
    pi.registerShortcut(shortcut, {
      description: "pi-web-access",
      handler: async (ctx) => {
        const runtime = await ensureRuntime(pi, ctx);
        const registered = runtime.shortcuts.get(shortcut);
        return registered?.handler?.(ctx);
      },
    });
  }

  pi.on("session_tree", async (event, ctx) => {
    if (loadedRuntime)
      await runHandlers(loadedRuntime, "session_tree", event, ctx);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (loadedRuntime)
      await runHandlers(loadedRuntime, "session_shutdown", event, ctx);
  });
}
