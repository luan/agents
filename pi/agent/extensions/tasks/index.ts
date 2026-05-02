import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { runCommand as defaultRunCommand } from "../shared/ct-runner";

type TaskCommand = "add" | "list" | "show" | "update" | "delete";

interface Config {
	enabled: boolean;
	command: string;
}

interface Runtime {
	runCommand?: typeof defaultRunCommand;
}

const extensionDir = dirname(fileURLToPath(import.meta.url));
const configPath = join(extensionDir, "config.json");

const defaultConfig: Config = {
	enabled: true,
	command: "ct",
};

function loadConfig(): Config {
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Partial<Config>;
		return { ...defaultConfig, ...parsed };
	} catch {
		return defaultConfig;
	}
}

function pushOption(args: string[], name: string, value: unknown): void {
	if (typeof value !== "string" || value.length === 0) return;
	args.push(name, value);
}

export function buildTaskCommand(action: TaskCommand, params: Record<string, unknown>): string[] {
	const args = ["task", action];
	switch (action) {
		case "add":
			args.push(String(params.title ?? ""));
			pushOption(args, "--body", params.body);
			pushOption(args, "--status", params.status);
			break;
		case "list":
			pushOption(args, "--status", params.status);
			if (params.all === true) args.push("--all");
			break;
		case "show":
		case "delete":
			args.push(String(params.id ?? ""));
			break;
		case "update":
			args.push(String(params.id ?? ""));
			pushOption(args, "--title", params.title);
			pushOption(args, "--body", params.body);
			pushOption(args, "--status", params.status);
			break;
	}
	args.push("--json");
	return args;
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

async function executeTask(
	command: string,
	runCommand: typeof defaultRunCommand,
	cwd: string,
	action: TaskCommand,
	params: Record<string, unknown>,
	signal?: AbortSignal,
) {
	const result = await runCommand(command, buildTaskCommand(action, params), cwd, signal);
	return textResult(result.stdout.trim() || result.stderr.trim());
}

export default function tasksExtension(pi: ExtensionAPI, runtime: Runtime = {}) {
	const config = loadConfig();
	if (!config.enabled) return;

	const runCommand = runtime.runCommand ?? defaultRunCommand;
	let cwd = process.cwd();
	pi.on("session_start", (_event, ctx) => {
		cwd = ctx.cwd;
	});

	pi.registerTool({
		name: "task_add",
		label: "task_add",
		renderShell: "self",
		description: "Create a persisted project task via ct task add.",
		promptSnippet: "Create a persisted project task",
		parameters: Type.Object({
			title: Type.String({ description: "Task title" }),
			body: Type.Optional(Type.String({ description: "Task details/body" })),
			status: Type.Optional(Type.String({ description: "Task status (default: open)" })),
		}),
		execute: (_toolCallId, params, signal) => executeTask(config.command, runCommand, cwd, "add", params, signal),
	});

	pi.registerTool({
		name: "task_list",
		label: "task_list",
		renderShell: "self",
		description: "List persisted project tasks via ct task list.",
		promptSnippet: "List persisted project tasks",
		parameters: Type.Object({
			status: Type.Optional(Type.String({ description: "Filter by status" })),
			all: Type.Optional(Type.Boolean({ description: "Include completed/canceled tasks" })),
		}),
		execute: (_toolCallId, params, signal) => executeTask(config.command, runCommand, cwd, "list", params, signal),
	});

	pi.registerTool({
		name: "task_show",
		label: "task_show",
		renderShell: "self",
		description: "Show one persisted project task by ID or unique prefix.",
		promptSnippet: "Show a persisted project task",
		parameters: Type.Object({
			id: Type.String({ description: "Task ID or unique prefix" }),
		}),
		execute: (_toolCallId, params, signal) => executeTask(config.command, runCommand, cwd, "show", params, signal),
	});

	pi.registerTool({
		name: "task_update",
		label: "task_update",
		renderShell: "self",
		description: "Update a persisted project task by ID or unique prefix.",
		promptSnippet: "Update a persisted project task",
		parameters: Type.Object({
			id: Type.String({ description: "Task ID or unique prefix" }),
			title: Type.Optional(Type.String({ description: "New title" })),
			body: Type.Optional(Type.String({ description: "New details/body" })),
			status: Type.Optional(Type.String({ description: "New status" })),
		}),
		execute: (_toolCallId, params, signal) => executeTask(config.command, runCommand, cwd, "update", params, signal),
	});

	pi.registerTool({
		name: "task_delete",
		label: "task_delete",
		renderShell: "self",
		description: "Delete a persisted project task by ID or unique prefix.",
		promptSnippet: "Delete a persisted project task",
		parameters: Type.Object({
			id: Type.String({ description: "Task ID or unique prefix" }),
		}),
		execute: (_toolCallId, params, signal) => executeTask(config.command, runCommand, cwd, "delete", params, signal),
	});
}
