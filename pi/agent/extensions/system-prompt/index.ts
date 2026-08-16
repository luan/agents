import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import Mustache, { type TemplateSpans } from "mustache";
import { isCodeModeEnabled } from "../code-mode/mode.ts";
import { buildCoreToolDeclarations } from "../code-mode/nested-dispatch.ts";
import { resolveRuntimeShell } from "../exec-command/adapter/runtime-shell.ts";
import { sessionIdFromContext } from "../shared/session-context.ts";
import { getRegisteredTool } from "../shared/tool-registry.ts";
import { buildCavemanPrompt, isCavemanMode, resolveCavemanMode } from "./caveman.ts";

const SYSTEM_PROMPT_TEMPLATE = readFileSync(new URL("./SYSTEM_PROMPT.md.mustache", import.meta.url), "utf8").trimEnd();

type EnvironmentContextEnvironment = {
	id?: string;
	cwd: string;
	shell?: string;
};

type EnvironmentContextOptions = {
	environments?: EnvironmentContextEnvironment[];
	currentDate?: string | null;
	timezone?: string | null;
	shell?: string;
};

type EnvironmentContextEnvironmentView = {
	id: string;
	cwd: string;
	shell: string;
};

type EnvironmentContextView = {
	hasSingleEnvironment: boolean;
	singleEnvironment: EnvironmentContextEnvironmentView | null;
	hasMultipleEnvironments: boolean;
	environments: EnvironmentContextEnvironmentView[];
	currentDate: string | null;
	timezone: string | null;
};

type SystemPromptBuildOptions = BuildSystemPromptOptions & {
	environmentContext?: EnvironmentContextOptions;
	now?: Date;
	cavemanPrompt?: string | null;
	sessionId?: string;
	/** Overrides the registry lookup. Tests only; a session always derives it. */
	coreToolDeclarations?: string | null;
	/** Overrides code-mode/config.json. Tests only; a session always reads the file. */
	codeMode?: boolean;
};

export default async function systemPromptExtension(pi: ExtensionAPI) {
	pi.registerCommand("caveman", {
		description: "Set Caveman style: lite, full, ultra, or off",
		getArgumentCompletions: (prefix: string) => {
			const modes = ["lite", "full", "ultra", "off"].filter((mode) => mode.startsWith(prefix.trim().toLowerCase()));
			return modes.length > 0 ? modes.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const mode = args.trim().toLowerCase();
			if (!mode) {
				const currentMode = resolveCavemanMode(ctx.cwd);
				ctx.ui.notify(`Caveman mode: ${currentMode ?? "off"}. Usage: /caveman <lite|full|ultra|off>`, "info");
				return;
			}
			if (mode !== "off" && !isCavemanMode(mode)) {
				ctx.ui.notify("Usage: /caveman <lite|full|ultra|off>", "warning");
				return;
			}

			const path = join(ctx.cwd, ".pi", "caveman.json");
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${JSON.stringify({ mode }, null, 2)}\n`);
			ctx.ui.notify(`Caveman mode set to ${mode}.`, "info");
		},
	});
	// `before_agent_start` runs once per user prompt (agent-session.js:885), and a throw inside it makes pi fall back
	// to `_baseSystemPrompt` (agent-session.js:906-908) for every later request. Measured on a real boundary in session
	// 019ffca9: instructions went 90855 -> 28928 chars, 77 -> 34 headings, and `declare const tools`,
	// `<available_skills>`, `<pi_instructions>` and `<environment_context>` all vanished. Both the base pi handed us
	// and the prompt we built are kept, so `before_provider_request` can tell that fallback from a real prompt.
	let lastBaseSystemPrompt: string | undefined;
	let lastBuiltSystemPrompt: string | undefined;

	pi.on("before_agent_start", (event, ctx) => {
		const cavemanMode = resolveCavemanMode(ctx.cwd);
		if (typeof event.systemPrompt === "string") lastBaseSystemPrompt = event.systemPrompt;

		try {
			const systemPrompt = buildSystemPrompt(event.systemPrompt, {
				...event.systemPromptOptions,
				cavemanPrompt: cavemanMode ? buildCavemanPrompt(cavemanMode) : null,
				cwd: ctx.cwd,
				sessionId: sessionIdFromContext(ctx),
			});
			lastBuiltSystemPrompt = systemPrompt;
			return { systemPrompt };
		} catch (error) {
			// `buildCoreToolDeclarations()` throws on conflicting output schemas (nested-dispatch.ts:353) and
			// `assertTemplateValues` throws on a missing view value, so one bad registration silently downgraded
			// every later turn. Reuse the last good prompt instead of handing the turn back to pi's base.
			ctx.ui?.notify?.(
				`System prompt build failed: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return lastBuiltSystemPrompt ? { systemPrompt: lastBuiltSystemPrompt } : undefined;
		}
	});

	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload as Record<string, unknown>;
		const instructions = payload.instructions;
		if (typeof instructions !== "string") return;

		// An exact match against the base pi handed us: a post-compaction `agent.continue()` (agent-session.js:776)
		// issues its request without `before_agent_start`, so the override is gone and pi sends the base verbatim.
		// Comparing whole strings of different lengths is a length check, so this costs nothing per request.
		const restored =
			lastBuiltSystemPrompt && instructions === lastBaseSystemPrompt ? lastBuiltSystemPrompt : instructions;

		const cavemanMode = resolveCavemanMode(ctx.cwd);
		if (!cavemanMode) return restored === instructions ? undefined : { ...payload, instructions: restored };

		const cavemanPrompt = buildCavemanPrompt(cavemanMode);
		const normalizedInstructions = restored.split(cavemanPrompt).join("").trimEnd();

		return {
			...payload,
			instructions: `${normalizedInstructions}\n\n${cavemanPrompt}`,
		};
	});
}

// `read` gates the resource-URI paragraph and the whole skills catalogue, so testing the active set deleted them.
// `selectedTools` remains the fallback for a unit test where nothing registered through shared/tool-registry.ts.
function isToolReachable(name: string, selectedTools: string[], sessionId?: string): boolean {
	return getRegisteredTool(name, sessionId) !== undefined || selectedTools.includes(name);
}

const DIRECT_TOOL_ORDER = ["exec", "wait", "ask_user"];

// `selectedTools` is pi's active tool array, which tool-policy/policy.ts has already collapsed to the direct surface.
function formatDirectToolList(tools: string[]): string {
	const quoted = [
		...DIRECT_TOOL_ORDER.filter((name) => tools.includes(name)),
		...tools.filter((name) => !DIRECT_TOOL_ORDER.includes(name)).toSorted(),
	].map((name) => `\`${name}\``);
	if (quoted.length === 0) return "`exec`";
	if (quoted.length === 1) return quoted[0] as string;
	return `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
}

export function buildSystemPrompt(original: string, options: SystemPromptBuildOptions): string {
	const {
		customPrompt,
		selectedTools,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
		cavemanPrompt,
	} = options;
	const promptCwd = cwd.replace(/\\/g, "/");

	const now = options.now ?? new Date();
	const date = formatDate(now);

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];
	const tools = selectedTools || ["read", "bash", "edit", "write"];

	const hasFind = isToolReachable("find", tools, options.sessionId);
	const hasRead = isToolReachable("read", tools, options.sessionId);
	// Code-mode off makes every declared tool direct, so the bullets below name the tool rather than `tools.<name>`.
	const codeMode = options.codeMode ?? isCodeModeEnabled();

	const readmePath = original.match(/- Main documentation: (.+)/)?.[1] || null;
	const docsPath = original.match(/- Additional docs: (.+)/)?.[1] || null;
	const examplesPath = original.match(/- Examples: (.+)/)?.[1] || null;
	const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);

	return renderTemplate("SYSTEM_PROMPT.md.mustache", SYSTEM_PROMPT_TEMPLATE, {
		appendSystemPrompt: appendSystemPrompt || null,
		cavemanPrompt: cavemanPrompt || null,
		codeMode,
		contextFiles,
		customPrompt: customPrompt || null,
		directToolList: formatDirectToolList(tools),
		toolPrefix: codeMode ? "tools." : "",
		docsPath: docsPath ?? "null",
		environmentContext: buildEnvironmentContextView({
			currentDate: date,
			timezone: currentTimezone(),
			...options.environmentContext,
			environments: options.environmentContext?.environments ?? [
				{
					cwd: promptCwd,
					shell: options.environmentContext?.shell ?? defaultShellName(),
				},
			],
		}),
		examplesPath: examplesPath ?? "null",
		hasFind,
		hasContextFiles: contextFiles.length > 0,
		hasRead,
		hasExecCommand: isToolReachable("exec_command", tools, options.sessionId),
		hasSpawnAgent: isToolReachable("spawn_agent", tools, options.sessionId),
		coreToolDeclarations:
			options.coreToolDeclarations !== undefined
				? options.coreToolDeclarations
				: (buildCoreToolDeclarations(undefined, options.sessionId, options.cwd) ?? null),
		includeSkills: hasRead && visibleSkills.length > 0,
		promptGuidelines: uniqueNonEmptyLines(promptGuidelines ?? []),
		readmePath: readmePath ?? "null",
		skills: visibleSkills,
	});
}

function formatDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");

	return `${year}-${month}-${day}`;
}

function currentTimezone(): string | null {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
}

function defaultShellName(): string {
	return shellDisplayName(process.env.SHELL || process.env.ComSpec);
}

function shellDisplayName(shell: string | undefined): string {
	const resolvedShell = resolveRuntimeShell(shell);
	const displayShell = resolvedShell || "unknown";
	const parts = displayShell.split(/[\\/]/).filter(Boolean);

	return parts.at(-1) ?? displayShell;
}

function buildEnvironmentContextView(context: EnvironmentContextOptions): EnvironmentContextView {
	const defaultShell = context.shell ?? defaultShellName();
	const environments = (context.environments ?? []).map((environment) => ({
		id: environment.id ?? "",
		cwd: environment.cwd,
		shell: shellDisplayName(environment.shell ?? defaultShell),
	}));

	return {
		hasSingleEnvironment: environments.length === 1,
		singleEnvironment: environments.length === 1 ? environments[0] : null,
		hasMultipleEnvironments: environments.length > 1,
		environments,
		currentDate: context.currentDate || null,
		timezone: context.timezone || null,
	};
}

function uniqueNonEmptyLines(lines: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const line of lines) {
		const normalized = line.trim();
		if (normalized.length === 0 || seen.has(normalized)) {
			continue;
		}

		seen.add(normalized);
		result.push(normalized);
	}

	return result;
}

type TemplateView = Record<string, unknown>;
type TemplateToken = TemplateSpans[number];

function renderTemplate(templateName: string, template: string, view: TemplateView): string {
	const tokens = Mustache.parse(template);
	assertTemplateValues(templateName, tokens, [view]);

	return Mustache.render(template, view, undefined, { escape: escapeXml });
}

function assertTemplateValues(templateName: string, tokens: TemplateSpans, contexts: unknown[]): void {
	for (const token of tokens) {
		const [type, name] = token;

		if (type === "name" || type === "&") {
			const value = lookupTemplateValue(contexts, name);
			if (!value.exists) {
				throw new Error(`Missing ${templateName} value for {{${name}}}`);
			}
		}

		if (type === "#" || type === "^") {
			const value = lookupTemplateValue(contexts, name);
			if (!value.exists) {
				throw new Error(`Missing ${templateName} section value for {{#${name}}}`);
			}

			const nestedTokens = getNestedTokens(token);
			if (nestedTokens) {
				assertSectionTemplateValues(templateName, nestedTokens, contexts, value.value, type);
			}
		}
	}
}

function assertSectionTemplateValues(
	templateName: string,
	tokens: TemplateSpans,
	contexts: unknown[],
	sectionValue: unknown,
	sectionType: "#" | "^",
): void {
	if (sectionType === "^") {
		if (!isTruthyMustacheValue(sectionValue)) {
			assertTemplateValues(templateName, tokens, contexts);
		}
		return;
	}

	if (Array.isArray(sectionValue)) {
		for (const item of sectionValue) {
			assertTemplateValues(templateName, tokens, [...contexts, item]);
		}
		return;
	}

	if (sectionValue && typeof sectionValue === "object") {
		assertTemplateValues(templateName, tokens, [...contexts, sectionValue]);
		return;
	}

	if (sectionValue) {
		assertTemplateValues(templateName, tokens, contexts);
	}
}

function isTruthyMustacheValue(value: unknown): boolean {
	if (Array.isArray(value)) {
		return value.length > 0;
	}

	return Boolean(value);
}

function getNestedTokens(token: TemplateToken): TemplateSpans | undefined {
	const nested = token[4];

	return Array.isArray(nested) ? (nested as TemplateSpans) : undefined;
}

function lookupTemplateValue(contexts: unknown[], name: string): { exists: boolean; value?: unknown } {
	if (name === ".") {
		const value = contexts.at(-1);
		return { exists: value !== undefined, value };
	}

	for (let i = contexts.length - 1; i >= 0; i--) {
		const context = contexts[i];
		const value = lookupInContext(context, name);

		if (value.exists) {
			return value;
		}
	}

	return { exists: false };
}

function lookupInContext(context: unknown, name: string): { exists: boolean; value?: unknown } {
	if (!context || typeof context !== "object") {
		return { exists: false };
	}

	let value: unknown = context;
	for (const part of name.split(".")) {
		if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) {
			return { exists: false };
		}

		value = (value as Record<string, unknown>)[part];
	}

	return { exists: true, value };
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
