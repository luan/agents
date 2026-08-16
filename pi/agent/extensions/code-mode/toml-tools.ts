import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RegisteredToolDefinition } from "../shared/tool-registry.ts";

declare const Bun: {
	TOML: { parse(source: string): unknown };
};

export const TOML_TOOLS_DIRNAME = "codex-conversion-custom-tools";
const TOOL_NAME_PATTERN = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

export interface TomlTool {
	name: string;
	usage: string;
	description: string;
	command: string;
	args: string[];
	input: "arg" | "stdin";
	deferLoading: boolean;
	yieldTimeMs?: number;
	sourcePath: string;
	disabledReason?: string;
}

export interface TomlDiscoveryResult {
	tools: TomlTool[];
	errors: Array<{ path: string; message: string }>;
}

function requiredString(value: unknown, field: string, path: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${path}: ${field} must be a non-empty string`);
	return value.trim();
}

function parseToml(source: string, path: string): Record<string, unknown> {
	try {
		const value = Bun.TOML.parse(source);
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("top-level value must be a table");
		return value as Record<string, unknown>;
	} catch (error) {
		throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function parseTomlTool(path: string, source: string): TomlTool {
	const name = basename(path, extname(path));
	if (!TOOL_NAME_PATTERN.test(name)) throw new Error(`${path}: filename must be a JavaScript-compatible tool name`);
	const value = parseToml(source, path);
	const allowed = new Set(["usage", "description", "command", "args", "input", "defer_loading", "yield_time_ms"]);
	const unknown = Object.keys(value).filter((key) => !allowed.has(key));
	if (unknown.length)
		throw new Error(`${path}: unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
	const command = requiredString(value.command, "command", path);
	const args = value.args === undefined ? [] : value.args;
	if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) {
		throw new Error(`${path}: args must be an array of strings`);
	}
	const input = value.input === undefined ? "arg" : value.input;
	if (input !== "arg" && input !== "stdin") throw new Error(`${path}: input must be "arg" or "stdin"`);
	const deferLoading = value.defer_loading === undefined ? true : value.defer_loading;
	if (typeof deferLoading !== "boolean") throw new Error(`${path}: defer_loading must be a boolean`);
	const yieldTimeMs = value.yield_time_ms;
	if (yieldTimeMs !== undefined && (!Number.isSafeInteger(yieldTimeMs) || Number(yieldTimeMs) < 0)) {
		throw new Error(`${path}: yield_time_ms must be a non-negative safe integer`);
	}
	const resolvedCommand =
		!isAbsolute(command) && (command.includes("/") || command.includes("\\"))
			? resolve(dirname(path), command)
			: command;
	return {
		name,
		usage: requiredString(value.usage, "usage", path),
		description: typeof value.description === "string" ? value.description.trim() : "",
		command: resolvedCommand,
		args: [...args],
		input,
		deferLoading,
		...(yieldTimeMs === undefined ? {} : { yieldTimeMs: Number(yieldTimeMs) }),
		sourcePath: path,
	};
}

export function discoverTomlTools(cwd = process.cwd(), agentDir = getAgentDir()): TomlDiscoveryResult {
	const byName = new Map<string, TomlTool>();
	const errors: Array<{ path: string; message: string }> = [];
	for (const dir of [join(agentDir, TOML_TOOLS_DIRNAME), join(cwd, ".pi", TOML_TOOLS_DIRNAME)]) {
		let paths: string[];
		try {
			paths = readdirSync(dir)
				.filter((name) => name.endsWith(".toml"))
				.sort()
				.map((name) => join(dir, name));
		} catch (error) {
			if ((error as { code?: unknown })?.code === "ENOENT") continue;
			errors.push({ path: dir, message: error instanceof Error ? error.message : String(error) });
			continue;
		}
		for (const path of paths) {
			const name = basename(path, extname(path));
			byName.delete(name);
			try {
				byName.set(name, parseTomlTool(path, readFileSync(path, "utf8")));
			} catch (error) {
				errors.push({ path, message: error instanceof Error ? error.message : String(error) });
			}
		}
	}
	return { tools: [...byName.values()].sort((left, right) => left.name.localeCompare(right.name)), errors };
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function tomlYieldTimeForSource(
	source: string,
	cwd = process.cwd(),
	agentDir = getAgentDir(),
): number | undefined {
	let configured: number | undefined;
	for (const tool of discoverTomlTools(cwd, agentDir).tools) {
		if (tool.yieldTimeMs === undefined) continue;
		const name = escapeRegExp(tool.name);
		// This can match a call inside a comment or string. That only lengthens the yield window.
		const call = new RegExp(`\\btools\\s*(?:\\.\\s*${name}\\b|\\[\\s*["']${name}["']\\s*\\])\\s*\\(`);
		if (!call.test(source)) continue;
		configured = configured === undefined ? tool.yieldTimeMs : Math.max(configured, tool.yieldTimeMs);
	}
	return configured;
}

export async function runTomlTool(tool: TomlTool, input: unknown, cwd: string, signal?: AbortSignal): Promise<string> {
	if (tool.disabledReason) throw new Error(`${tool.name} is disabled: ${tool.disabledReason}`);
	if (typeof input !== "string") throw new Error(`${tool.name} expects a string input`);
	if (signal?.aborted) throw new Error(`${tool.name} aborted`);
	const args = tool.input === "arg" ? [...tool.args, input] : [...tool.args];
	return new Promise((resolveOutput, reject) => {
		const child = spawn(tool.command, args, {
			cwd,
			shell: false,
			detached: process.platform !== "win32",
			stdio: [tool.input === "stdin" ? "pipe" : "ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const kill = () => {
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
				else child.kill();
			} catch {
				child.kill();
			}
		};
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			callback();
		};
		const rejectOversizedOutput = () => {
			if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) <= 50 * 1024) return;
			kill();
			finish(() => reject(new Error(`${tool.name} output exceeded 51200 bytes`)));
		};
		const onAbort = () => {
			kill();
			finish(() => reject(new Error(`${tool.name} aborted`)));
		};
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
			rejectOversizedOutput();
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
			rejectOversizedOutput();
		});
		child.on("error", (error) => finish(() => reject(error)));
		child.on("close", (code) =>
			finish(() => {
				if (code !== 0) {
					reject(
						new Error(
							`${tool.name} exited with code ${code ?? "unknown"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
						),
					);
				} else {
					resolveOutput(stdout.trimEnd() || stderr.trimEnd() || "(no output)");
				}
			}),
		);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (tool.input === "stdin") {
			child.stdin?.on("error", (error) => finish(() => reject(error)));
			child.stdin?.end(input);
		}
	});
}

export function asTomlRegisteredTool(tool: TomlTool): RegisteredToolDefinition {
	return {
		name: tool.name,
		description: tool.description || tool.usage,
		parameters: Type.Object({
			input: Type.String({ description: tool.usage }),
		}),
		execute: (async (
			_id: string,
			params: unknown,
			signal: AbortSignal | undefined,
			_update: unknown,
			ctx: unknown,
		) => {
			const value =
				params && typeof params === "object" && "input" in params ? (params as { input?: unknown }).input : params;
			const text = await runTomlTool(tool, value, (ctx as { cwd?: string })?.cwd ?? process.cwd(), signal);
			return { content: [{ type: "text", text }] };
		}) as RegisteredToolDefinition["execute"],
		tomlTool: tool,
	};
}
