import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { joinCommandTokens, normalizeTokens, shellSplit } from "../shell/tokenize.ts";

type ExecResultLike = {
	code: number;
	stdout?: string;
	stderr?: string;
};

type RtkResolution = {
	command: string;
	resolver: "which" | "where";
	resolvedPath?: string;
	warning?: string;
};

export type RtkRewriteDecision = {
	changed: boolean;
	originalCommand: string;
	rewrittenCommand: string;
	reason: "disabled" | "empty" | "already_rtk" | "no_match" | "ok";
	warning?: string;
};

export interface RtkWrapperState {
	enabled: boolean;
}

const RTK_REWRITE_TIMEOUT_MS = 3000;
const RTK_RESOLVE_TIMEOUT_MS = 1000;

function isExecResultLike(value: unknown): value is ExecResultLike {
	return typeof value === "object" && value !== null && "code" in value && typeof value.code === "number";
}

function trimDetail(value: string | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

function stripWrappingQuotes(value: string): string {
	const first = value[0];
	const last = value[value.length - 1];
	if (value.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'"))) {
		return value.slice(1, -1);
	}
	return value;
}

export function parseRtkExecutablePath(stdout: string): string | undefined {
	for (const line of stdout.split(/\r?\n/)) {
		const candidate = stripWrappingQuotes(line.trim());
		if (candidate) return candidate;
	}
	return undefined;
}

async function resolveRtkExecutable(pi: ExtensionAPI): Promise<RtkResolution> {
	const resolver: "which" | "where" = process.platform === "win32" ? "where" : "which";
	try {
		const result = await pi.exec(resolver, ["rtk"], { timeout: RTK_RESOLVE_TIMEOUT_MS });
		const resolvedPath = parseRtkExecutablePath(result.stdout ?? "");
		if (result.code === 0 && resolvedPath) {
			return { command: resolvedPath, resolver, resolvedPath };
		}
		const detail = trimDetail(result.stderr || result.stdout || `exit ${result.code}`);
		return {
			command: "rtk",
			resolver,
			warning: `rtk executable path resolution via ${resolver} failed${detail ? `: ${detail}` : ""}`,
		};
	} catch (error) {
		return {
			command: "rtk",
			resolver,
			warning: `rtk executable path resolution via ${resolver} failed: ${trimDetail(
				error instanceof Error ? error.message : String(error),
			)}`,
		};
	}
}

function isAlreadyRtk(command: string): boolean {
	const trimmed = command.trimStart();
	return trimmed === "rtk" || trimmed.startsWith("rtk ");
}

function isEnvAssignment(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function commandIndex(tokens: string[]): number | undefined {
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (!token || isEnvAssignment(token) || token === "command" || token === "builtin" || token === "noglob") {
			continue;
		}
		if (token === "env") continue;
		return index;
	}
	return undefined;
}

function commandName(token: string): string {
	return token.replace(/\\/g, "/").split("/").pop() ?? token;
}

function ripgrepCommandIndex(tokens: string[]): number | undefined {
	const index = commandIndex(tokens);
	if (index === undefined) return undefined;
	const name = commandName(tokens[index] ?? "");
	return name === "rg" || name === "ripgrep" ? index : undefined;
}

function rewriteRipgrepSegments(command: string): string | undefined {
	const tokens = normalizeTokens(shellSplit(command));
	let changed = false;
	const next: string[] = [];
	let segment: string[] = [];

	const flush = () => {
		if (segment.length === 0) return;
		const rgIndex = ripgrepCommandIndex(segment);
		if (rgIndex !== undefined) {
			next.push(...segment.slice(0, rgIndex), "rtk", "rg", ...segment.slice(rgIndex + 1));
			changed = true;
		} else {
			next.push(...segment);
		}
		segment = [];
	};

	for (const token of tokens) {
		if (token === "&&" || token === "||" || token === "|" || token === ";") {
			flush();
			next.push(token);
			continue;
		}
		segment.push(token);
	}
	flush();
	return changed ? joinCommandTokens(next) : undefined;
}

function splitTopLevelPipe(command: string): { left: string; separator: "|" | "|&"; right: string } | undefined {
	let quote: '"' | "'" | "`" | undefined;
	let escaped = false;
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index] ?? "";
		const next = command[index + 1] ?? "";
		if (escaped) {
			escaped = false;
			continue;
		}
		if (quote) {
			if (char === "\\" && quote !== "'") {
				escaped = true;
			} else if (char === quote) {
				quote = undefined;
			}
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			continue;
		}
		if (char !== "|" || command[index - 1] === ">") continue;
		if (next === "|") return undefined;
		const separator = next === "&" ? "|&" : "|";
		const rightStart = index + separator.length;
		return {
			left: command.slice(0, index).trim(),
			separator,
			right: command.slice(rightStart).trim(),
		};
	}
	return undefined;
}

export function applyRewrittenCommandShellSafetyFixups(command: string): string {
	if (process.platform !== "win32") return command;
	const pipe = splitTopLevelPipe(command);
	if (!pipe || !/^rtk(?:\.exe)?\s+/i.test(pipe.left) || !pipe.right) return command;

	const tempFile = "__pi_rtk_pipe_tmp";
	const status = "__pi_rtk_pipe_status";
	const redirect = pipe.separator === "|&" ? `> "$${tempFile}" 2>&1` : `> "$${tempFile}"`;
	const buffered = [
		"{",
		`${tempFile}="$(mktemp)" || exit $?;`,
		`${status}=0;`,
		`trap 'rm -f "$${tempFile}"' EXIT HUP INT TERM;`,
		`${pipe.left} ${redirect};`,
		`${status}=$?;`,
		`if [ $${status} -eq 0 ]; then (${pipe.right}) < "$${tempFile}"; ${status}=$?; fi;`,
		`exit $${status};`,
		"}",
	].join(" ");
	return buffered;
}

export async function computeRtkRewriteDecision(
	pi: ExtensionAPI,
	command: string,
	enabled: boolean,
): Promise<RtkRewriteDecision> {
	if (!enabled) {
		return { changed: false, originalCommand: command, rewrittenCommand: command, reason: "disabled" };
	}
	if (!command.trim()) {
		return { changed: false, originalCommand: command, rewrittenCommand: command, reason: "empty" };
	}
	if (isAlreadyRtk(command)) {
		return { changed: false, originalCommand: command, rewrittenCommand: command, reason: "already_rtk" };
	}
	const rtkRgCommand = rewriteRipgrepSegments(command);
	if (rtkRgCommand) {
		return {
			changed: true,
			originalCommand: command,
			rewrittenCommand: rtkRgCommand,
			reason: "ok",
		};
	}

	try {
		const resolution = await resolveRtkExecutable(pi);
		const result = await pi.exec(resolution.command, ["rewrite", command], { timeout: RTK_REWRITE_TIMEOUT_MS });
		if (!isExecResultLike(result)) {
			return {
				changed: false,
				originalCommand: command,
				rewrittenCommand: command,
				reason: "no_match",
				warning: "rtk rewrite returned an invalid result",
			};
		}
		if (result.code === 1) {
			return {
				changed: false,
				originalCommand: command,
				rewrittenCommand: command,
				reason: "no_match",
				warning: resolution.warning,
			};
		}
		if (result.code === 2) {
			return {
				changed: false,
				originalCommand: command,
				rewrittenCommand: command,
				reason: "no_match",
				warning: trimDetail(result.stderr) || "rtk denied rewrite",
			};
		}
		if (result.code !== 0 && result.code !== 3) {
			return {
				changed: false,
				originalCommand: command,
				rewrittenCommand: command,
				reason: "no_match",
				warning: `rtk rewrite exited ${result.code}`,
			};
		}
		const rewritten = result.stdout?.trim();
		if (!rewritten || rewritten === command) {
			return {
				changed: false,
				originalCommand: command,
				rewrittenCommand: command,
				reason: "no_match",
				warning: !rewritten ? "rtk returned empty output" : resolution.warning,
			};
		}
		return {
			changed: true,
			originalCommand: command,
			rewrittenCommand: applyRewrittenCommandShellSafetyFixups(rewritten),
			reason: "ok",
			warning: resolution.warning,
		};
	} catch (error) {
		return {
			changed: false,
			originalCommand: command,
			rewrittenCommand: command,
			reason: "no_match",
			warning: error instanceof Error ? error.message : String(error),
		};
	}
}
