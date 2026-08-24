import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

export const DEVELOPER_MESSAGE_CONTRIBUTIONS_KEY = "pi-developer-prompt/developer-messages/v1";
export const DEVELOPER_MESSAGE_CONTRIBUTIONS = Symbol.for(DEVELOPER_MESSAGE_CONTRIBUTIONS_KEY);

export interface DeveloperMessageRenderContext {
	provider?: string;
	activeTools: readonly string[];
	sessionId: string;
	prompt?: string;
	systemPromptOptions: BuildSystemPromptOptions;
}

export interface DeveloperMessageContribution {
	id: string;
	priority?: number;
	providers?: readonly string[];
	activeTools?: readonly string[];
	content: string | ((context: DeveloperMessageRenderContext) => string | undefined);
}

export interface DeveloperMessage {
	id: string;
	content: string;
}

export interface DeveloperPromptEnvironment {
	currentDate: string;
	timezone: string;
	shell: string;
}

export interface DeveloperMessageContributionRegistry extends Map<string, DeveloperMessageContribution> {
	readonly protocol: typeof DEVELOPER_MESSAGE_CONTRIBUTIONS_KEY;
	readonly version: 1;
}

type ContributionGlobal = typeof globalThis & {
	[DEVELOPER_MESSAGE_CONTRIBUTIONS]?: DeveloperMessageContributionRegistry;
};

export function getDeveloperMessageContributionRegistry(): DeveloperMessageContributionRegistry {
	const root = globalThis as ContributionGlobal;
	const existing = root[DEVELOPER_MESSAGE_CONTRIBUTIONS];
	if (isContributionRegistry(existing)) return existing;
	const registry = Object.assign(new Map<string, DeveloperMessageContribution>(), {
		protocol: DEVELOPER_MESSAGE_CONTRIBUTIONS_KEY,
		version: 1 as const,
	}) as DeveloperMessageContributionRegistry;
	root[DEVELOPER_MESSAGE_CONTRIBUTIONS] = registry;
	return registry;
}

export function registerDeveloperMessageContribution(contribution: DeveloperMessageContribution): () => void {
	if (!contribution.id.trim()) throw new Error("A developer message contribution needs an id");
	const registry = getDeveloperMessageContributionRegistry();
	registry.set(contribution.id, contribution);
	return () => {
		if (registry.get(contribution.id) === contribution) registry.delete(contribution.id);
	};
}

export function renderDeveloperMessages(context: DeveloperMessageRenderContext): DeveloperMessage[] {
	const active = new Set(context.activeTools);
	const contributions = [...getDeveloperMessageContributionRegistry().values()]
		.filter(
			(entry) => !entry.providers || (context.provider !== undefined && entry.providers.includes(context.provider)),
		)
		.filter((entry) => !entry.activeTools || entry.activeTools.every((tool) => active.has(tool)))
		.sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0) || left.id.localeCompare(right.id))
		.map((entry) => ({
			id: entry.id,
			value: typeof entry.content === "function" ? entry.content(context) : entry.content,
		}))
		.map(({ id, value }): DeveloperMessage | undefined => (value?.trim() ? { id, content: value.trim() } : undefined))
		.filter((entry): entry is DeveloperMessage => entry !== undefined);

	return contributions;
}

export function composeDeveloperMessages(
	context: DeveloperMessageRenderContext,
	cwd: string,
	environment = currentEnvironment(),
): DeveloperMessage[] {
	const messages: DeveloperMessage[] = [];
	messages.push(...renderDeveloperMessages(context));
	const shell = context.activeTools.includes("exec_command")
		? execCommandShellName(environment.shell)
		: environment.shell;
	const environmentContent = [
		"<environment_context>",
		`  <cwd>${cwd.replace(/\\/g, "/")}</cwd>`,
		`  <shell>${shell}</shell>`,
		`  <current_date>${environment.currentDate}</current_date>`,
		`  <timezone>${environment.timezone}</timezone>`,
		"</environment_context>",
	].join("\n");
	messages.push({
		id: "environment",
		content: environmentContent,
	});
	return messages;
}

function execCommandShellName(shell: string): string {
	if (basename(shell).toLowerCase() !== "fish") return basename(shell);
	if (process.platform === "win32") return "bash.exe";
	const candidates =
		process.platform === "darwin" ? ["/bin/zsh", "/bin/bash", "/bin/sh"] : ["/bin/bash", "/bin/zsh", "/bin/sh"];
	return basename(candidates.find((candidate) => existsSync(candidate)) ?? "/bin/sh");
}

function currentEnvironment(): DeveloperPromptEnvironment {
	const now = new Date();
	return {
		currentDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown",
		shell: basename(process.env.SHELL || process.env.ComSpec || "unknown"),
	};
}

// type-boundary: Symbol.for capabilities can be populated by another extension realm; this validator avoids instanceof Map.
function isContributionRegistry(value: unknown): value is DeveloperMessageContributionRegistry {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<DeveloperMessageContributionRegistry>;
	return (
		candidate.protocol === DEVELOPER_MESSAGE_CONTRIBUTIONS_KEY &&
		candidate.version === 1 &&
		typeof candidate.get === "function" &&
		typeof candidate.set === "function" &&
		typeof candidate.delete === "function" &&
		typeof candidate.values === "function" &&
		typeof candidate.clear === "function"
	);
}
