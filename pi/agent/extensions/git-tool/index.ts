import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type GitToolMode = "graphite" | "git-spice" | "main" | "none";

type StackingGitToolMode = "graphite" | "git-spice";

type GitToolExtensionOptions = {
	readGitToolConfig?: () => string | undefined;
	readCurrentBranch?: () => string | undefined;
	readTrunkBranch?: (mode: StackingGitToolMode) => string | undefined;
};

type ResourceDiscovery = {
	skillPaths?: string[];
};

type ToolCallEventLike = {
	toolName: string;
	input?: unknown;
	args?: unknown;
};

type TrunkGateState = {
	mode: GitToolMode;
	currentBranch?: string;
	trunkBranch?: string;
};

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const GRAPHITE_SKILLS_DIR = join(EXTENSION_DIR, "skill-resources", "graphite");
const GIT_SPICE_SKILLS_DIR = join(EXTENSION_DIR, "skill-resources", "git-spice");

export const GIT_TOOL_MAIN_PROMPT_ADDENDUM = `## Git tool strategy: current branch

This repository is configured with \`agents.git-tool=main\`. Do not assume a stacked-branch workflow. When the user asks you to commit or push, commit or push on the currently checked-out branch unless the user explicitly asks you to create or switch branches.`;

export const GIT_TOOL_GRAPHITE_PROMPT_ADDENDUM = `## Git tool strategy: Graphite

This repository is configured with \`agents.git-tool=graphite\`. Use Graphite for stacked-branch workflows. Use the \`submit\`, \`sync\`, \`restack\`, and \`stack\` skills for pushing, creating or updating PRs, syncing with trunk, rebasing/restacking, branch creation, stack navigation, and stack inspection.

Do not use raw \`git push\`, \`git rebase\`, \`git checkout -b\`, or \`gh pr create\` for stack workflows. Ordinary \`git status\`, \`git add\`, and \`git commit\` remain allowed when they do not replace a Graphite stack operation.`;

export const GIT_TOOL_GIT_SPICE_PROMPT_ADDENDUM = `## Git tool strategy: Git-Spice

This repository is configured with \`agents.git-tool=git-spice\`. Use Git-Spice for stacked-branch workflows. Use the \`submit\`, \`sync\`, \`restack\`, and \`stack\` skills for pushing, creating or updating Change Requests, syncing with trunk, rebasing/restacking, branch creation, stack navigation, and stack inspection.

Do not use raw \`git push\`, \`git rebase\`, \`git checkout -b\`, or \`gh pr create\` for stack workflows. Ordinary \`git status\`, \`git add\`, and \`git commit\` remain allowed when they do not replace a Git-Spice stack operation.`;

export default function gitToolExtension(pi: ExtensionAPI, options: GitToolExtensionOptions = {}) {
	const readGitToolConfig = options.readGitToolConfig ?? defaultReadGitToolConfig;
	const readCurrentBranch = options.readCurrentBranch ?? defaultReadCurrentBranch;
	const readTrunkBranch = options.readTrunkBranch ?? defaultReadTrunkBranch;
	const configuredMode = () => parseGitToolMode(readGitToolConfig());

	pi.on("resources_discover", () => gitToolResources(configuredMode()));

	pi.on("before_agent_start", (event) => {
		const systemPrompt = appendGitToolPrompt(event.systemPrompt, configuredMode());
		if (systemPrompt === event.systemPrompt) return;
		return { systemPrompt };
	});

	pi.on("tool_call", (event) => {
		const mode = configuredMode();
		return gitToolToolCallBlock(event, {
			mode,
			currentBranch: isStackingMode(mode) ? readCurrentBranch() : undefined,
			trunkBranch: isStackingMode(mode) ? readTrunkBranch(mode) : undefined,
		});
	});
}

export function parseGitToolMode(value: string | undefined): GitToolMode {
	switch (value) {
		case "graphite":
		case "git-spice":
		case "main":
		case "none":
			return value;
		default:
			return "none";
	}
}

export function gitToolResources(mode: GitToolMode): ResourceDiscovery {
	switch (mode) {
		case "graphite":
			return { skillPaths: [GRAPHITE_SKILLS_DIR] };
		case "git-spice":
			return { skillPaths: [GIT_SPICE_SKILLS_DIR] };
		case "main":
		case "none":
			return {};
	}
}

export function appendGitToolPrompt(systemPrompt: string, mode: GitToolMode): string {
	const addendum = gitToolPromptAddendum(mode);
	if (!addendum) return systemPrompt;
	if (systemPrompt.includes(addendum)) return systemPrompt;
	return `${systemPrompt}\n\n${addendum}`;
}

export function gitToolToolCallBlock(
	event: ToolCallEventLike,
	state: TrunkGateState,
): { block: true; reason: string } | undefined {
	if (!isStackingMode(state.mode)) return undefined;
	if (!isBlockedSideEffectTool(event.toolName)) return undefined;
	if (isShellTool(event.toolName) && isAllowedTrunkShellCommand(commandFromToolCall(event), state.mode))
		return undefined;

	if (!state.currentBranch || !state.trunkBranch) {
		return {
			block: true,
			reason: `Could not verify the ${gitToolLabel(state.mode)} trunk branch for agents.git-tool=${state.mode}. Install/configure ${gitToolLabel(
				state.mode,
			)} or set agents.git-tool=none/main before running side-effect tools.`,
		};
	}

	if (state.currentBranch !== state.trunkBranch) return undefined;

	return {
		block: true,
		reason: `Start a stack branch first. This repository is configured with agents.git-tool=${state.mode}, and side-effect tools are blocked on trunk (${state.trunkBranch}). Use the start skill or a configured ${gitToolLabel(
			state.mode,
		)} branch creation command before editing or running shell commands.`,
	};
}

function gitToolPromptAddendum(mode: GitToolMode): string | undefined {
	switch (mode) {
		case "graphite":
			return GIT_TOOL_GRAPHITE_PROMPT_ADDENDUM;
		case "git-spice":
			return GIT_TOOL_GIT_SPICE_PROMPT_ADDENDUM;
		case "main":
			return GIT_TOOL_MAIN_PROMPT_ADDENDUM;
		case "none":
			return undefined;
	}
}

function isStackingMode(mode: GitToolMode): mode is StackingGitToolMode {
	return mode === "graphite" || mode === "git-spice";
}

function isBlockedSideEffectTool(toolName: string): boolean {
	const normalized = toolBaseName(toolName);
	return (
		normalized === "apply_patch" ||
		normalized === "edit" ||
		normalized === "write" ||
		normalized === "exec_command" ||
		normalized === "bash"
	);
}

function isShellTool(toolName: string): boolean {
	const normalized = toolBaseName(toolName);
	return normalized === "exec_command" || normalized === "bash";
}

function toolBaseName(toolName: string): string {
	return toolName.split(".").at(-1) ?? toolName;
}

function commandFromToolCall(event: ToolCallEventLike): string | undefined {
	return commandFromUnknown(event.input) ?? commandFromUnknown(event.args);
}

function commandFromUnknown(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const command = record.command ?? record.cmd;
	return typeof command === "string" ? command : undefined;
}

function isAllowedTrunkShellCommand(command: string | undefined, mode: StackingGitToolMode): boolean {
	if (!command) return false;
	const tokens = shellWords(command);
	if (tokens.length === 0) return false;
	return (
		isReadOnlyGitInspection(tokens) || isAllowedToolInspection(tokens, mode) || isAllowedBranchCreate(tokens, mode)
	);
}

function isReadOnlyGitInspection(tokens: string[]): boolean {
	if (tokens[0] !== "git") return false;
	const subcommand = tokens[1];
	if (subcommand === "status") return true;
	if (subcommand === "rev-parse" || subcommand === "symbolic-ref") return true;
	if (subcommand === "branch") {
		return tokens
			.slice(2)
			.every((arg) =>
				[
					"-a",
					"-r",
					"-v",
					"-vv",
					"--all",
					"--remotes",
					"--verbose",
					"--show-current",
					"--list",
					"--contains",
					"--merged",
					"--no-merged",
				].includes(arg),
			);
	}
	if (subcommand === "config") {
		const args = tokens.slice(2);
		return args.some((arg) => arg === "--get" || arg === "--get-regexp" || arg === "--list" || arg === "-l");
	}
	return false;
}

function isAllowedBranchCreate(tokens: string[], mode: StackingGitToolMode): boolean {
	if (mode === "graphite") return tokens[0] === "gt" && tokens[1] === "create" && Boolean(tokens[2]);
	return (
		tokens[0] === "gs" &&
		((tokens[1] === "branch" && tokens[2] === "create" && Boolean(tokens[3])) ||
			(tokens[1] === "bc" && Boolean(tokens[2])))
	);
}

function isAllowedToolInspection(tokens: string[], mode: StackingGitToolMode): boolean {
	if (mode === "graphite") return tokens[0] === "gt" && tokens[1] === "trunk";
	return (
		tokens[0] === "gs" && tokens[1] === "trunk" && tokens.slice(2).every((arg) => arg === "-n" || arg === "--dry-run")
	);
}

function shellWords(command: string): string[] {
	return command
		.trim()
		.split(/\s+/)
		.filter((token) => token !== "2>&1");
}

function gitToolLabel(mode: StackingGitToolMode): string {
	return mode === "graphite" ? "Graphite" : "Git-Spice";
}

function defaultReadGitToolConfig(): string | undefined {
	return gitOutput(["config", "--get", "agents.git-tool"]);
}

function defaultReadCurrentBranch(): string | undefined {
	return (
		gitOutput(["symbolic-ref", "--short", "HEAD"]) ??
		(gitOutput(["rev-parse", "--verify", "HEAD"]) ? "(detached)" : undefined)
	);
}

function defaultReadTrunkBranch(mode: StackingGitToolMode): string | undefined {
	return mode === "graphite" ? commandOutput("gt", ["trunk"]) : commandOutput("gs", ["trunk", "-n"]);
}

function gitOutput(args: string[]): string | undefined {
	return commandOutput("git", args);
}

function commandOutput(command: string, args: string[]): string | undefined {
	try {
		return execFileSync(command, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		})
			.trim()
			.split("\n")[0];
	} catch {
		return undefined;
	}
}
