import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

type VisualExplainerParams = {
  action: "prepare" | "render";
  topic?: string;
  goal?: string;
  files?: string[];
  audience?: string;
  preferSubagent?: boolean;
  filename?: string;
  outputPath?: string;
  html?: string;
  open?: boolean;
  overwrite?: boolean;
};

type OpenStatus = "disabled" | "unsupported" | "dispatched" | "failed";

type OpenResult = {
  openAttempted: boolean;
  openStatus: OpenStatus;
  openError?: string;
};

type SubagentDetection = {
  available: boolean;
  allToolsHasSubagent?: boolean;
  error?: string;
};

type PrepareDetails = {
  action: "prepare";
  topic: string;
  goal?: string;
  audience?: string;
  files: string[];
  subagentAvailable: boolean;
  subagentAllToolsAvailable?: boolean;
  subagentDetectionError?: string;
  recommendedFlow: string[];
  subagentPrompt?: string;
};

type RenderDetails = OpenResult & {
  action: "render";
  path: string;
};

type VisualExplainerDetails = PrepareDetails | RenderDetails;

const visualExplainerParameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["prepare", "render"],
      description: "Choose prepare to plan a visual explanation, or render to write complete HTML.",
    },
    topic: {
      type: "string",
      description: "For action=prepare: what the visual explanation should cover.",
    },
    goal: {
      type: "string",
      description: "For action=prepare: what the user wants to understand, decide, or communicate.",
    },
    files: {
      type: "array",
      items: { type: "string" },
      description: "For action=prepare: relevant files or paths the agent may inspect before generating the visual explanation.",
    },
    audience: {
      type: "string",
      description: "For action=prepare: intended audience, such as developer, PM, team, reviewer, or executive.",
    },
    preferSubagent: {
      type: "boolean",
      description: "For action=prepare: when true, recommend a scout subagent first if the subagent tool is active. Defaults to true.",
    },
    filename: {
      type: "string",
      description: "For action=render: basename for the default ~/.agent/diagrams/ output. The tool appends .html if missing.",
    },
    outputPath: {
      type: "string",
      description: "For action=render: explicit output path. Use this instead of filename when the user requested a destination.",
    },
    html: {
      type: "string",
      description: "For action=render: complete self-contained HTML document to write.",
    },
    open: {
      type: "boolean",
      description: "For action=render: open the written HTML file with the system opener. Defaults to false and requires explicit permission.",
    },
    overwrite: {
      type: "boolean",
      description: "For action=render: replace an existing output file. Defaults to false.",
    },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

function detectSubagent(pi: ExtensionAPI): SubagentDetection {
  let error: string | undefined;

  try {
    return { available: pi.getActiveTools().includes("subagent") };
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  try {
    return {
      available: false,
      allToolsHasSubagent: pi.getAllTools().some((tool) => tool.name === "subagent"),
      error,
    };
  } catch (caught) {
    const fallbackError = caught instanceof Error ? caught.message : String(caught);
    return { available: false, error: error ? `${error}; ${fallbackError}` : fallbackError };
  }
}

function outputFilename(input: string) {
  const raw = input.trim().replace(/^@/, "");

  if (!raw) throw new Error("filename is required");
  if (raw.includes("/") || raw.includes("\\")) throw new Error("filename must be a basename, not a path");
  if (raw.includes("..")) throw new Error("filename must not contain '..'");
  if (/[\0-\x1f\x7f]/.test(raw)) throw new Error("filename must not contain control characters");

  return /\.html?$/i.test(raw) ? raw : `${raw}.html`;
}

export function resolveExplicitOutputPath(input: string, home = homedir()) {
  const trimmed = input.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return resolve(home, trimmed.slice(2));
  return resolve(trimmed);
}

export function writeHtmlAtomically(
  outputPath: string,
  html: string,
  overwrite: boolean,
  commitOverwrite: (temporaryPath: string, finalPath: string) => void = renameSync,
) {
  const temporaryPath = join(dirname(outputPath), `.${basename(outputPath)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(fd, html, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    if (overwrite) commitOverwrite(temporaryPath, outputPath);
    else {
      linkSync(temporaryPath, outputPath);
      unlinkSync(temporaryPath);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporaryPath, { force: true });
  }
}

function assertHtmlDocument(html: string) {
  const trimmed = html.trim();
  if (!trimmed) throw new Error("html is required");

  const start = trimmed.replace(/^\s*<!doctype\s+html\b[^>]*>\s*/i, "").replace(/^(?:<!--[\s\S]*?-->\s*)+/, "");
  if (!/^<html[\s>]/i.test(start) || !/<\/html>\s*$/i.test(trimmed)) {
    throw new Error("html must be a complete HTML document starting with <!doctype html> or <html> and ending with </html>");
  }
}

export function openerForPlatform(path: string, platform: NodeJS.Platform = process.platform) {
  if (platform === "darwin") return { command: "open", args: [path] };
  if (platform === "linux") return { command: "xdg-open", args: [path] };
  if (platform === "win32") return { command: "explorer.exe", args: [path] };
  return undefined;
}

async function openInBrowser(path: string): Promise<OpenResult> {
  const opener = openerForPlatform(path);
  if (!opener) return { openAttempted: false, openStatus: "unsupported" };
  const { command, args } = opener;

  return await new Promise<OpenResult>((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    let settled = false;

    const settle = (result: OpenResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.once("error", (error) => {
      settle({
        openAttempted: true,
        openStatus: "failed",
        openError: error.message,
      });
    });

    child.once("exit", (code, signal) => {
      if (code !== 0) {
        settle({
          openAttempted: true,
          openStatus: "failed",
          openError: code === null ? `opener exited with signal ${signal ?? "unknown"}` : `opener exited with code ${code}`,
        });
      }
    });

    const timer = setTimeout(() => {
      settle({ openAttempted: true, openStatus: "dispatched" });
    }, 250);

    child.unref();
  });
}

function prepareVisualExplanation(pi: ExtensionAPI, params: VisualExplainerParams): AgentToolResult<VisualExplainerDetails> {
  if (typeof params.topic !== "string") throw new Error("topic must be a string for action=prepare");
  if (params.goal !== undefined && typeof params.goal !== "string") throw new Error("goal must be a string when provided");
  if (params.audience !== undefined && typeof params.audience !== "string") throw new Error("audience must be a string when provided");
  if (params.files !== undefined && (!Array.isArray(params.files) || !params.files.every((file) => typeof file === "string"))) {
    throw new Error("files must be an array of strings when provided");
  }
  if (params.preferSubagent !== undefined && typeof params.preferSubagent !== "boolean") {
    throw new Error("preferSubagent must be a boolean when provided");
  }

  const topic = params.topic.trim();
  if (!topic) throw new Error("topic is required");

  const goal = params.goal?.trim();
  const audience = params.audience?.trim();
  const files = params.files?.map((file) => file.trim()).filter(Boolean) ?? [];
  const subagent = detectSubagent(pi);
  const shouldUseSubagent = params.preferSubagent !== false && subagent.available;
  const subagentPrompt = shouldUseSubagent
    ? `Scout the codebase for a visual explanation about ${topic}.${goal ? ` The user goal is: ${goal}.` : ""}${files.length ? ` Start with these files/paths: ${files.join(", ")}.` : ""} Return concise findings, important entities/flows, and visual structure recommendations. Do not edit files.`
    : undefined;
  const recommendedFlow = shouldUseSubagent
    ? [
        "Run a scout subagent to gather repo context and identify the visual structure.",
        "Synthesize the findings into a concise visual outline for the target audience.",
        "Read the relevant visual-explainer references or templates before generating the page.",
        "Generate a complete self-contained HTML document using the visual-explainer skill.",
        "Call visual_explainer with action=render, html, either filename or outputPath, and open=true only when visible review is permitted.",
      ]
    : [
        "Gather the needed context directly in the main agent.",
        "Create a concise visual outline for the target audience.",
        "Read the relevant visual-explainer references or templates before generating the page.",
        "Generate a complete self-contained HTML document using the visual-explainer skill.",
        "Call visual_explainer with action=render, html, either filename or outputPath, and open=true only when visible review is permitted.",
      ];

  const summaryLines = [
    `Prepared visual explanation for: ${topic}`,
    goal ? `Goal: ${goal}` : undefined,
    audience ? `Audience: ${audience}` : undefined,
    shouldUseSubagent ? "Recommended start: use a scout subagent for context." : "Recommended start: gather context directly in this session.",
    "Recommended flow:",
    ...recommendedFlow.map((step, i) => `${i + 1}. ${step}`),
    subagentPrompt ? `Suggested subagent task:\n${subagentPrompt}` : undefined,
  ];

  return {
    content: [{ type: "text" as const, text: summaryLines.filter((line): line is string => Boolean(line)).join("\n") }],
    details: {
      action: "prepare",
      topic,
      goal,
      audience,
      files,
      subagentAvailable: subagent.available,
      subagentAllToolsAvailable: subagent.allToolsHasSubagent,
      subagentDetectionError: subagent.error,
      recommendedFlow,
      subagentPrompt,
    },
  };
}

async function renderVisualExplanation(params: VisualExplainerParams, signal?: AbortSignal): Promise<AgentToolResult<VisualExplainerDetails>> {
  if (params.filename !== undefined && typeof params.filename !== "string") throw new Error("filename must be a string when provided");
  if (params.outputPath !== undefined && typeof params.outputPath !== "string") throw new Error("outputPath must be a string when provided");
  if ((params.filename === undefined) === (params.outputPath === undefined)) throw new Error("provide exactly one of filename or outputPath for action=render");
  if (typeof params.html !== "string") throw new Error("html must be a string for action=render");
  if (params.open !== undefined && typeof params.open !== "boolean") throw new Error("open must be a boolean when provided");
  if (params.overwrite !== undefined && typeof params.overwrite !== "boolean") throw new Error("overwrite must be a boolean when provided");
  const requestedOutputPath = params.outputPath?.trim();
  if (params.outputPath !== undefined && !requestedOutputPath) throw new Error("outputPath must not be empty");
  if (requestedOutputPath && /[\0-\x1f\x7f]/.test(requestedOutputPath)) throw new Error("outputPath must not contain control characters");

  signal?.throwIfAborted();

  const finalOutputPath = requestedOutputPath === undefined
    ? join(homedir(), ".agent", "diagrams", outputFilename(params.filename!))
    : resolveExplicitOutputPath(requestedOutputPath);
  assertHtmlDocument(params.html);

  const outputDir = dirname(finalOutputPath);
  mkdirSync(outputDir, { recursive: true });
  if (lstatSync(outputDir).isSymbolicLink()) throw new Error(`${outputDir} must not be a symlink`);
  if (existsSync(finalOutputPath) && params.overwrite !== true) throw new Error(`${finalOutputPath} already exists; set overwrite=true only with user authorization`);
  if (existsSync(finalOutputPath) && lstatSync(finalOutputPath).isSymbolicLink()) {
    throw new Error(`${finalOutputPath} must not be a symlink`);
  }

  signal?.throwIfAborted();
  writeHtmlAtomically(finalOutputPath, params.html, params.overwrite === true);


  const openResult = params.open === true
    ? await openInBrowser(finalOutputPath)
    : { openAttempted: false, openStatus: "disabled" as const };

  let message = `Wrote ${finalOutputPath}.`;
  if (openResult.openStatus === "dispatched") {
    message += " Browser open requested.";
  } else if (openResult.openStatus === "failed") {
    message += ` Browser open failed: ${openResult.openError ?? "unknown error"}.`;
  } else if (openResult.openStatus === "unsupported") {
    message += " Browser opening is unsupported on this platform.";
  }

  return {
    content: [{ type: "text" as const, text: message }],
    details: { action: "render", path: finalOutputPath, ...openResult },
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool<typeof visualExplainerParameters, VisualExplainerDetails>({
    name: "visual_explainer",
    label: "Visual Explainer",
    description: "Use with action=prepare when a visual explanation would help; use action=render after complete HTML is ready to write to the requested path or the default diagrams directory.",
    promptSnippet: "Plan or render visual-explainer HTML. Preserve requested paths; opening and visible review are opt-in.",
    promptGuidelines: [
      "Offer a visual explanation only for architecture, flows, comparisons, plans, diffs, data, or other work where spatial relationships materially improve understanding.",
      "Ask before action=prepare unless the user explicitly requested a diagram or visual artifact.",
      "When action=prepare recommends scouting, gather context before generating the complete HTML.",
      "Use action=render with outputPath when the user requested a destination; otherwise use filename for ~/.agent/diagrams/. Pass open=true or overwrite=true only with user authorization.",
    ],
    parameters: visualExplainerParameters,
    executionMode: "sequential",
    async execute(_toolCallId: string, params: VisualExplainerParams, signal?: AbortSignal) {
      if (params.action !== "prepare" && params.action !== "render") {
        throw new Error("action must be either 'prepare' or 'render'");
      }

      if (params.action === "prepare") return prepareVisualExplanation(pi, params);
      return await renderVisualExplanation(params, signal);
    },
  });
}
