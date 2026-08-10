import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import Mustache, { type TemplateSpans } from "mustache";
import { resolveRuntimeShell } from "../exec-command/adapter/runtime-shell.ts";
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
	pi.on("before_agent_start", (event, ctx) => {
		const cavemanMode = resolveCavemanMode(ctx.cwd);

		return {
			systemPrompt: buildSystemPrompt(event.systemPrompt, {
				...event.systemPromptOptions,
				cavemanPrompt: cavemanMode ? buildCavemanPrompt(cavemanMode) : null,
				cwd: ctx.cwd,
			}),
		};
	});
	pi.on("before_provider_request", (event, ctx) => {
		const cavemanMode = resolveCavemanMode(ctx.cwd);
		const payload = event.payload as Record<string, unknown>;
		const instructions = payload.instructions;
		if (!cavemanMode || typeof instructions !== "string") return;

		const cavemanPrompt = buildCavemanPrompt(cavemanMode);
		const normalizedInstructions = instructions.split(cavemanPrompt).join("").trimEnd();

		return {
			...payload,
			instructions: `${normalizedInstructions}\n\n${cavemanPrompt}`,
		};
	});
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

	const hasSearch = tools.includes("search");
	const hasFind = tools.includes("find");
	const hasRead = tools.includes("read");
	const hasSkillTool = tools.includes("skill");

	const readmePath = original.match(/- Main documentation: (.+)/)?.[1] || null;
	const docsPath = original.match(/- Additional docs: (.+)/)?.[1] || null;
	const examplesPath = original.match(/- Examples: (.+)/)?.[1] || null;
	const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);

	return renderTemplate("SYSTEM_PROMPT.md.mustache", SYSTEM_PROMPT_TEMPLATE, {
		appendSystemPrompt: appendSystemPrompt || null,
		cavemanPrompt: cavemanPrompt || null,
		contextFiles,
		customPrompt: customPrompt || null,
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
		hasSearch,
		hasExecCommand: tools.includes("exec_command"),
		includeSkills: (hasSkillTool || hasRead) && visibleSkills.length > 0,
		promptGuidelines: uniqueNonEmptyLines(promptGuidelines ?? []),
		readmePath: readmePath ?? "null",
		readSkillFallback: !hasSkillTool && hasRead,
		skills: visibleSkills,
		skillToolActive: hasSkillTool,
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
