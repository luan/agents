import { spawn } from "node:child_process";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import { chip, nf, okLine, renderText, title, warnLine } from "../shared/ct-render.ts";

const vaultKindSchema = Type.Union([
	Type.Literal("all"),
	Type.Literal("spec"),
	Type.Literal("plan"),
	Type.Literal("review"),
	Type.Literal("report"),
	Type.Literal("doc"),
]);

const scopedVaultKindSchema = Type.Union([
	Type.Literal("spec"),
	Type.Literal("plan"),
	Type.Literal("review"),
	Type.Literal("report"),
	Type.Literal("doc"),
]);

const ctVaultCreateSchema = Type.Object({
	kind: scopedVaultKindSchema,
	topic: Type.String({ description: "Artifact topic" }),
	project: Type.Optional(
		Type.String({
			description: "Project path (defaults to current git repo / cwd)",
		}),
	),
	slug: Type.Optional(Type.String({ description: "Custom slug" })),
	source: Type.Optional(
		Type.String({ description: "Source artifact stem for wiki-linking" }),
	),
	tags: Type.Optional(Type.String({ description: "Comma-separated tags" })),
	dive: Type.Optional(
		Type.Boolean({ description: "Route to dive/ instead of spec/" }),
	),
});

const ctVaultListSchema = Type.Object({
	kind: Type.Optional(vaultKindSchema),
	project: Type.Optional(
		Type.String({ description: "Filter by project path" }),
	),
	all: Type.Optional(
		Type.Boolean({ description: "Show artifacts from all projects" }),
	),
	archived: Type.Optional(
		Type.Boolean({ description: "Show archived artifacts" }),
	),
	includeDives: Type.Optional(
		Type.Boolean({ description: "Include dive/ files" }),
	),
	json: Type.Optional(Type.Boolean({ description: "Output as JSON" })),
});

const ctVaultReadSchema = Type.Object({
	kind: Type.Optional(vaultKindSchema),
	target: Type.String({ description: "Artifact file path or stem" }),
	frontmatter: Type.Optional(
		Type.Boolean({ description: "Output frontmatter as JSON" }),
	),
});

const ctVaultArchiveSchema = Type.Object({
	kind: Type.Optional(vaultKindSchema),
	target: Type.Optional(
		Type.String({ description: "Artifact file path or stem" }),
	),
	targets: Type.Optional(
		Type.Array(Type.String({ description: "Artifact file path or stem" })),
	),
	dryRun: Type.Optional(
		Type.Boolean({ description: "Preview without writing" }),
	),
});

const ctVaultPruneSchema = Type.Object({
	kind: Type.Optional(vaultKindSchema),
	days: Type.Optional(Type.Number({ description: "Age threshold in days" })),
	dryRun: Type.Optional(
		Type.Boolean({ description: "Preview without writing" }),
	),
	project: Type.Optional(
		Type.String({ description: "Filter by project path" }),
	),
});

const ctVaultCommentsSchema = Type.Object({
	kind: Type.Optional(vaultKindSchema),
	target: Type.String({ description: "Artifact file path or stem" }),
	json: Type.Optional(Type.Boolean({ description: "Output as JSON" })),
});

const ctVaultRenameSchema = Type.Object({
	kind: Type.Optional(vaultKindSchema),
	old: Type.String({ description: "Current file path or stem" }),
	newSlug: Type.String({ description: "New slug" }),
});

const ctVaultRetagSchema = Type.Object({
	kind: Type.Optional(vaultKindSchema),
	target: Type.String({ description: "Artifact file path or stem" }),
});

const ctVaultRelatedSchema = Type.Object({
	topic: Type.String({ description: "Topic to match against" }),
	project: Type.Optional(
		Type.String({
			description: "Project path (defaults to current git repo / cwd)",
		}),
	),
	archive: Type.Optional(
		Type.Boolean({ description: "Include archived artifacts" }),
	),
});

const ctVaultCheckSchema = Type.Object({
	archive: Type.Optional(
		Type.Boolean({ description: "Include archived artifacts" }),
	),
});

const ctVaultSearchSchema = Type.Object({
	query: Type.String({ description: "Search query" }),
	kind: Type.Optional(scopedVaultKindSchema),
	project: Type.Optional(
		Type.String({ description: "Filter by project path" }),
	),
	archive: Type.Optional(
		Type.Boolean({ description: "Include archived artifacts" }),
	),
	json: Type.Optional(Type.Boolean({ description: "Output as JSON" })),
});

const ctVaultStatusSchema = Type.Object({});

const ctVaultCommitSchema = Type.Object({
	path: Type.String({
		description: "Absolute or vault-relative path to the edited file",
	}),
	message: Type.Optional(Type.String({ description: "Commit message" })),
});

type CtResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

function trimOutput(text: string): string {
	return text.trim();
}

function mergeOutput(stdout: string, stderr: string): string {
	const out = trimOutput(stdout);
	const err = trimOutput(stderr);
	if (out && err) return `${out}\n\n[stderr]\n${err}`;
	return out || err;
}

function prettyJson(text: string): string {
	try {
		return `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
	} catch {
		return text;
	}
}

function formatCommand(command: string, args: string[]): string {
	return [
		command,
		...args.map((arg) =>
			arg.includes(" ") || arg.includes("\t") ? JSON.stringify(arg) : arg,
		),
	].join(" ");
}

function runCommand(
	command: string,
	args: string[],
	cwd: string,
	signal?: AbortSignal,
	input?: string,
): Promise<CtResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];

		child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
		child.on("error", (error) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				reject(new Error(`${command} not found on PATH`));
				return;
			}
			reject(error);
		});

		const onAbort = () => child.kill();
		signal?.addEventListener("abort", onAbort, { once: true });

		if (input === undefined) {
			child.stdin.end();
		} else {
			child.stdin.end(input);
		}

		child.on("close", (exitCode) => {
			signal?.removeEventListener("abort", onAbort);
			const stdout = Buffer.concat(stdoutChunks).toString("utf8");
			const stderr = Buffer.concat(stderrChunks).toString("utf8");
			if (exitCode === 0) {
				resolve({ stdout, stderr, exitCode: 0 });
				return;
			}
			reject(
				new Error(
					`${formatCommand(command, args)} failed with exit code ${exitCode ?? 1}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
				),
			);
		});
	});
}

async function runCt(
	args: string[],
	cwd: string,
	signal?: AbortSignal,
	input?: string,
): Promise<CtResult> {
	return runCommand("ct", args, cwd, signal, input);
}

function toolResult(
	command: string,
	cwd: string,
	result: CtResult,
	transform?: (text: string) => string,
) {
	const stdout = trimOutput(result.stdout);
	const stderr = trimOutput(result.stderr);
	const base = transform
		? transform(stdout || stderr)
		: mergeOutput(result.stdout, result.stderr);
	const text =
		transform && stderr ? `${trimOutput(base)}\n\n[stderr]\n${stderr}` : base;
	return {
		content: [{ type: "text" as const, text: text || "(no output)" }],
		details: {
			command,
			cwd,
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
		},
	};
}

function vaultIcon(operation: string): string {
	if (operation === "status") return "";
	if (operation === "create") return "";
	if (operation === "read") return nf.read;
	if (operation === "archive" || operation === "prune") return "";
	if (operation === "search") return "";
	if (operation === "check") return "󰅙";
	if (operation === "commit") return "";
	return "󰋼";
}

function renderVaultCall(operation: string, detail: string | undefined, theme: any, ctx: any) {
	return renderText(ctx, title(theme, vaultIcon(operation), `vault ${operation}`, detail ?? ""));
}

function renderVaultResult(operation: string, result: any, theme: any, ctx: any) {
	const details = result?.details ?? {};
	const raw = String(details.stdout || result?.content?.[0]?.text || "").trim();
	const stderr = String(details.stderr || "").trim();
	const failed = Boolean(stderr && !raw);
	const line = failed ? warnLine : okLine;
	return renderText(ctx, line(theme, [chip(theme, vaultIcon(operation), operation, summarizeVaultOutput(raw || stderr))]));
}

function summarizeVaultOutput(raw: string): string {
	if (!raw) return "ok";
	const parsed = parseJson(raw);
	if (Array.isArray(parsed)) return String(parsed.length);
	if (parsed && typeof parsed === "object") {
		const obj = parsed as Record<string, unknown>;
		for (const key of ["artifact_count", "count", "unresolved_count"]) {
			if (typeof obj[key] === "number") return String(obj[key]);
		}
		if (Array.isArray(obj.artifacts)) return String(obj.artifacts.length);
		if (Array.isArray(obj.comments)) return String(obj.comments.length);
		if (Array.isArray(obj.results)) return String(obj.results.length);
	}
	const first = raw.split("\n").find((line) => line.trim().length > 0) ?? "ok";
	return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

export default function vaultExtension(pi: ExtensionAPI) {
	const registerTool = pi.registerTool.bind(pi) as any;

	registerTool({
		name: "vault_create",
		label: "vault create",
		description: "Create a new vault artifact scaffold.",
		promptSnippet: "Create a new vault artifact scaffold.",
		promptGuidelines: [
			"Use create + edit + commit. Never write vault files directly.",
		],
		parameters: ctVaultCreateSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const args = [
				"vault",
				"create",
				"-t",
				params.kind,
				"--topic",
				params.topic,
			];
			if (params.project) args.push("--project", params.project);
			if (params.slug) args.push("--slug", params.slug);
			if (params.source) args.push("--source", params.source);
			if (params.tags) args.push("--tags", params.tags);
			const dive = (params as { dive?: boolean }).dive === true;
			if (dive) args.push("--dive");

			const result = await runCt(args, ctx.cwd, signal);
			return toolResult(formatCommand("ct", args), ctx.cwd, result);
		},
		renderCall: (args, theme, ctx) => renderVaultCall("create", `${args.kind} · ${args.topic}`, theme, ctx),
		renderResult: (result, _options, theme, ctx) => renderVaultResult("create", result, theme, ctx),
	});

	registerTool({
		name: "vault_list",
		label: "vault list",
		description: "List vault artifacts.",
		promptSnippet: "List vault artifacts.",
		parameters: ctVaultListSchema,
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const kind = params.kind ?? "all";
			const useJson = params.json !== false;
			const args = ["vault", "list", "-t", kind];
			if (useJson) args.push("--json");
			if (params.project) args.push("--project", params.project);
			if (params.all) args.push("--all");
			if (params.archived) args.push("--archived");
			if (params.includeDives) args.push("--include-dives");

			const result = await runCt(args, ctx.cwd, signal);
			return toolResult(
				formatCommand("ct", args),
				ctx.cwd,
				result,
				useJson ? prettyJson : undefined,
			);
		},
		renderCall: (args, theme, ctx) => renderVaultCall("list", args.kind ?? "all", theme, ctx),
		renderResult: (result, _options, theme, ctx) => renderVaultResult("list", result, theme, ctx),
	});

	registerTool({
		name: "vault_read",
		label: "vault read",
		description: "Read a vault artifact by stem or path.",
		promptSnippet: "Read a vault artifact by stem or path.",
		parameters: ctVaultReadSchema,
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const kind = params.kind ?? "all";
			const args = ["vault", "read", "-t", kind];
			if (params.frontmatter) args.push("--frontmatter");
			args.push(params.target);

			const result = await runCt(args, ctx.cwd, signal);
			return toolResult(
				formatCommand("ct", args),
				ctx.cwd,
				result,
				params.frontmatter ? prettyJson : undefined,
			);
		},
		renderCall: (args, theme, ctx) => renderVaultCall("read", args.target, theme, ctx),
		renderResult: (result, _options, theme, ctx) => renderVaultResult("read", result, theme, ctx),
	});

	registerTool({
		name: "vault_archive",
		label: "vault archive",
		description: "Archive one or more vault artifacts.",
		promptSnippet: "Archive one or more vault artifacts.",
		promptGuidelines: ["Archive only consumed artifacts."],
		parameters: ctVaultArchiveSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const kind = params.kind ?? "all";
			const args = ["vault", "archive", "-t", kind];
			if (params.dryRun) args.push("--dry-run");
			if (params.targets && params.targets.length > 0) {
				args.push("--batch", ...params.targets);
			} else if (params.target) {
				args.push(params.target);
			} else {
				throw new Error("ct vault archive requires target or targets");
			}

			const result = await runCt(args, ctx.cwd, signal);
			return toolResult(formatCommand("ct", args), ctx.cwd, result);
		},
		renderCall: (args, theme, ctx) => renderVaultCall("archive", args.target ?? `${args.targets?.length ?? 0} targets`, theme, ctx),
		renderResult: (result, _options, theme, ctx) => renderVaultResult("archive", result, theme, ctx),
	});

	registerTool({
		name: "vault_prune",
		label: "vault prune",
		description: "Archive artifacts older than N days.",
		promptSnippet: "Archive artifacts older than N days.",
		parameters: ctVaultPruneSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const kind = params.kind ?? "all";
			const args = ["vault", "prune", "-t", kind];
			if (params.days !== undefined) args.push("--days", String(params.days));
			if (params.dryRun) args.push("--dry-run");
			if (params.project) args.push("--project", params.project);

			const result = await runCt(args, ctx.cwd, signal);
			return toolResult(formatCommand("ct", args), ctx.cwd, result);
		},
		renderCall: (args, theme, ctx) => renderVaultCall("prune", `${args.kind ?? "all"} · ${args.days ?? "default"}d`, theme, ctx),
		renderResult: (result, _options, theme, ctx) => renderVaultResult("prune", result, theme, ctx),
	});

	registerTool({
		name: "vault_comments",
		label: "vault comments",
		description: "Extract inline HTML comments from a vault artifact.",
		promptSnippet: "Extract inline HTML comments from a vault artifact.",
		parameters: ctVaultCommentsSchema,
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const kind = params.kind ?? "all";
			const useJson = params.json !== false;
			const args = ["vault", "comments", "-t", kind];
			if (useJson) args.push("--json");
			args.push(params.target);
			const result = await runCt(args, ctx.cwd, signal);
			return toolResult(
				formatCommand("ct", args),
				ctx.cwd,
				result,
				useJson ? prettyJson : undefined,
			);
		},
		renderCall: (args, theme, ctx) => renderVaultCall("comments", args.target, theme, ctx),
		renderResult: (result, _options, theme, ctx) => renderVaultResult("comments", result, theme, ctx),
	});

	registerTool({
		name: "vault_rename",
		label: "vault rename",
		description: "Rename a vault artifact and update its frontmatter.",
		promptSnippet: "Rename a vault artifact and update its frontmatter.",
		promptGuidelines: [
			"Use when the artifact slug should change; keep wiki-links in mind.",
		],
		parameters: ctVaultRenameSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const kind = params.kind ?? "all";
			const args = ["vault", "rename", "-t", kind, params.old, params.newSlug];
			const result = await runCt(args, ctx.cwd, signal);
			return toolResult(formatCommand("ct", args), ctx.cwd, result);
		},
		renderCall: (args, theme, ctx) => renderVaultCall("rename", `${args.old} → ${args.newSlug}`, theme, ctx),
		renderResult: (result, _options, theme, ctx) => renderVaultResult("rename", result, theme, ctx),
	});

	registerTool({
		name: "vault_retag",
		label: "vault retag",
		description: "Fix auto-derived tags in artifact frontmatter.",
		promptSnippet: "Fix auto-derived tags in artifact frontmatter.",
		parameters: ctVaultRetagSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const kind = params.kind ?? "all";
			const args = ["vault", "retag", "-t", kind, params.target];
			const result = await runCt(args, ctx.cwd, signal);
			return toolResult(formatCommand("ct", args), ctx.cwd, result);
		},
		renderCall: (args, theme, ctx) => renderVaultCall("retag", args.target, theme, ctx),
		renderResult: (result, _options, theme, ctx) => renderVaultResult("retag", result, theme, ctx),
	});

	registerTool({
		name: "vault_related",
		label: "vault related",
		description: "Find related artifacts by topic overlap.",
		promptSnippet: "Find related artifacts by topic overlap.",
		parameters: ctVaultRelatedSchema,
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const args = ["vault", "related", params.topic];
			if (params.project) args.push("--project", params.project);
			if (params.archive) args.push("--archive");

			const result = await runCt(args, ctx.cwd, signal);
			return toolResult(formatCommand("ct", args), ctx.cwd, result);
		},
		renderCall: (args, theme, ctx) => renderVaultCall("related", args.topic, theme, ctx),
		renderResult: (result, _options, theme, ctx) => renderVaultResult("related", result, theme, ctx),
	});

	registerTool({
		name: "vault_check",
		label: "vault check",
		description: "Check for unresolved wiki-links.",
		promptSnippet: "Check for unresolved wiki-links.",
		parameters: ctVaultCheckSchema,
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const args = ["vault", "check"];
			if (params.archive) args.push("--archive");

			const result = await runCt(args, ctx.cwd, signal);
			return toolResult(formatCommand("ct", args), ctx.cwd, result);
		},
		renderCall: (_args, theme, ctx) => renderVaultCall("check", undefined, theme, ctx),
		renderResult: (result, _options, theme, ctx) => renderVaultResult("check", result, theme, ctx),
	});

	registerTool({
		name: "vault_search",
		label: "vault search",
		description: "Search vault artifacts.",
		promptSnippet: "Search vault artifacts.",
		parameters: ctVaultSearchSchema,
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const useJson = params.json !== false;
			const args = ["vault", "search", params.query];
			if (useJson) args.push("--json");
			if (params.kind) args.push("--type", params.kind);
			if (params.project) args.push("--project", params.project);
			if (params.archive) args.push("--archive");

			const result = await runCt(args, ctx.cwd, signal);
			return toolResult(
				formatCommand("ct", args),
				ctx.cwd,
				result,
				useJson ? prettyJson : undefined,
			);
		},
		renderCall: (args, theme, ctx) => renderVaultCall("search", args.query, theme, ctx),
		renderResult: (result, _options, theme, ctx) => renderVaultResult("search", result, theme, ctx),
	});

	registerTool({
		name: "vault_status",
		label: "vault status",
		description: "Show vault git state and artifact count.",
		promptSnippet: "Show vault git state and artifact count.",
		parameters: ctVaultStatusSchema,
		executionMode: "parallel",
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			const command = "ct vault status";
			const result = await runCt(["vault", "status"], ctx.cwd, signal);
			return toolResult(command, ctx.cwd, result);
		},
		renderCall: (_args, theme, ctx) => renderVaultCall("status", undefined, theme, ctx),
		renderResult: (result, _options, theme, ctx) => renderVaultResult("status", result, theme, ctx),
	});

	registerTool({
		name: "vault_commit",
		label: "vault commit",
		description: "Commit and push edits made to a vault file.",
		promptSnippet: "Commit and push edits made to a vault file.",
		promptGuidelines: ["Call after editing an existing vault file."],
		parameters: ctVaultCommitSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const args = ["vault", "commit", params.path];
			if (params.message) args.splice(2, 0, "--message", params.message);

			const result = await runCt(args, ctx.cwd, signal);
			return toolResult(formatCommand("ct", args), ctx.cwd, result);
		},
		renderCall: (args, theme, ctx) => renderVaultCall("commit", args.path, theme, ctx),
		renderResult: (result, _options, theme, ctx) => renderVaultResult("commit", result, theme, ctx),
	});
}
