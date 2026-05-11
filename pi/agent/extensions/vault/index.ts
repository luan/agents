import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, normalize, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { runCommand as defaultRunCommand } from "../shared/ct-runner";

const PLANNOTATOR_REQUEST_CHANNEL = "plannotator:request";
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

type ArtifactType = "all" | "research" | "plan" | "doc";
type ConcreteArtifactType = Exclude<ArtifactType, "all">;
type GateType = "research" | "plan" | "tests" | "docs" | "custom";

type PlannotatorResponse<T> =
	| { status: "handled"; result: T }
	| { status: "unavailable"; error?: string }
	| { status: "error"; error: string };

type AnnotationResult = {
	feedback?: string;
	exit?: boolean;
	approved?: boolean;
	savedPath?: string;
};

type CodeReviewResult = {
	approved?: boolean;
	feedback?: string;
	annotations?: unknown[];
	agentSwitch?: string;
	reviewId?: string;
	savedPath?: string;
	exit?: boolean;
};

type ToolResultDetails = Record<string, unknown>;

const inFlightPlannotatorRequests = new Map<string, Promise<PlannotatorResponse<unknown>>>();

type EventBus = {
	emit?: (channel: string, data: unknown) => void;
};

function textResult(text: string, details?: ToolResultDetails) {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

function parseJson(stdout: string, command: string) {
	const trimmed = stdout.trim();
	if (!trimmed) return {};
	try {
		return JSON.parse(trimmed) as unknown;
	} catch (error) {
		throw new Error(`${command} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function kindArgs(kind?: ArtifactType): string[] {
	return kind && kind !== "all" ? ["--type", kind] : [];
}

function commaTags(tags?: string[]): string | undefined {
	const clean = tags?.map((tag) => tag.trim()).filter(Boolean) ?? [];
	return clean.length ? clean.join(",") : undefined;
}

export function buildVaultCreateArgs(params: {
	type: ConcreteArtifactType;
	topic: string;
	tags?: string[];
	source?: string;
	dive?: boolean;
}): string[] {
	const args = ["create", "--type", params.type, "--topic", params.topic];
	const tags = commaTags(params.tags);
	if (tags) args.push("--tags", tags);
	if (params.source) args.push("--source", params.source);
	if (params.dive) args.push("--dive");
	return args;
}

export function buildVaultCommitArgs(params: { path: string; message?: string }): string[] {
	const args = ["commit", params.path];
	if (params.message) args.push("--message", params.message);
	return args;
}

async function runVaultJson(cwd: string, args: string[], signal?: AbortSignal) {
	const fullArgs = ["vault", ...args, "--json"];
	const result = await defaultRunCommand("ct", fullArgs, cwd, signal);
	const parsed = parseJson(result.stdout, `ct ${fullArgs.join(" ")}`);
	return textResult(result.stdout.trim() || JSON.stringify(parsed), { result: parsed });
}

function emitPlannotator<T>(
	pi: ExtensionAPI,
	action: string,
	payload: Record<string, unknown>,
	timeoutMs: number,
): Promise<PlannotatorResponse<T>> {
	const requestKey = `${action}:${JSON.stringify(payload)}`;
	const inFlight = inFlightPlannotatorRequests.get(requestKey) as Promise<PlannotatorResponse<T>> | undefined;
	if (inFlight) return inFlight;

	const events = (pi as ExtensionAPI & { events?: EventBus }).events;
	if (typeof events?.emit !== "function") {
		return Promise.resolve({ status: "unavailable", error: "Plannotator event bus is unavailable" });
	}

	const request = new Promise<PlannotatorResponse<T>>((resolve) => {
		const requestId = `vault-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		const timer = setTimeout(() => {
			resolve({ status: "unavailable", error: `Plannotator ${action} timed out after ${timeoutMs}ms` });
		}, timeoutMs);
		events.emit(PLANNOTATOR_REQUEST_CHANNEL, {
			requestId,
			action,
			payload,
			respond(response: PlannotatorResponse<T>) {
				clearTimeout(timer);
				resolve(response);
			},
		});
	});
	inFlightPlannotatorRequests.set(requestKey, request as Promise<PlannotatorResponse<unknown>>);
	request.finally(() => {
		if (inFlightPlannotatorRequests.get(requestKey) === request) inFlightPlannotatorRequests.delete(requestKey);
	});
	return request;
}

function failClosedDetails(
	gateType: string,
	target: string,
	approved: boolean,
	extra?: Record<string, unknown>,
): ToolResultDetails {
	return {
		gateType,
		timestamp: new Date().toISOString(),
		target,
		approved,
		...extra,
	};
}

function requireHandled<T>(response: PlannotatorResponse<T>, gateType: string, target: string) {
	if (response.status !== "handled") {
		const reason = response.status === "error" ? response.error : (response.error ?? "Plannotator unavailable");
		return {
			ok: false as const,
			result: undefined,
			text: `Plannotator ${gateType} gate failed closed for ${target}: ${reason}`,
			details: failClosedDetails(gateType, target, false, { reason, responseStatus: response.status }),
		};
	}
	return { ok: true as const, result: response.result };
}

function blueprintsDir() {
	return process.env.CT_BLUEPRINTS_DIR || join(homedir(), "blueprints");
}

function resolveExistingPath(candidates: string[]) {
	for (const candidate of candidates) {
		if (existsSync(candidate)) return realpathSync(candidate);
	}
	return undefined;
}

function resolvePlannotatorTargetPath(targetPath: string, cwd?: string) {
	const rawTarget = targetPath.trim();
	if (!rawTarget) {
		return { ok: false as const, target: "<empty>", reason: "targetPath is required" };
	}

	if (rawTarget.startsWith("~/")) {
		return { ok: true as const, path: normalize(join(homedir(), rawTarget.slice(2))) };
	}
	if (isAbsolute(rawTarget)) {
		return { ok: true as const, path: normalize(rawTarget) };
	}

	const candidates = [];
	if (cwd) candidates.push(resolve(cwd, rawTarget));
	const vaultRoot = blueprintsDir();
	candidates.push(resolve(vaultRoot, rawTarget));
	if (cwd) candidates.push(resolve(vaultRoot, basename(cwd), rawTarget));
	if (rawTarget.startsWith("blueprints/")) candidates.push(resolve(homedir(), rawTarget));

	const resolved = resolveExistingPath(candidates);
	if (resolved) return { ok: true as const, path: resolved };

	return {
		ok: false as const,
		target: rawTarget,
		reason: "relative targetPath could not be resolved to an existing local file",
	};
}

export async function runPlannotatorGate(
	pi: ExtensionAPI,
	params: {
		targetPath: string;
		gateType: GateType;
		title?: string;
		instructions?: string;
		timeoutMs?: number;
		cwd?: string;
	},
) {
	const targetPath = resolvePlannotatorTargetPath(params.targetPath, params.cwd);
	if (!targetPath.ok) {
		return textResult(
			`Plannotator ${params.gateType} gate failed closed for ${targetPath.target}: ${targetPath.reason}`,
			{
				...failClosedDetails(params.gateType, targetPath.target, false, { reason: targetPath.reason }),
			},
		);
	}

	const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const response = await emitPlannotator<AnnotationResult>(
		pi,
		"annotate",
		{
			filePath: targetPath.path,
			gate: true,
			mode: "annotate",
			title: params.title,
			instructions: params.instructions,
		},
		timeoutMs,
	);
	const handled = requireHandled(response, params.gateType, targetPath.path);
	if (!handled.ok) return textResult(handled.text, handled.details);

	const result = handled.result;
	if (!result.approved || result.exit) {
		const reason = result.exit ? "review session closed" : result.feedback || "not approved";
		return textResult(`Plannotator ${params.gateType} gate denied for ${targetPath.path}: ${reason}`, {
			...failClosedDetails(params.gateType, targetPath.path, false, {
				feedback: result.feedback,
				exit: result.exit,
				savedPath: result.savedPath,
			}),
		});
	}

	return textResult(`Plannotator ${params.gateType} gate approved for ${targetPath.path}.`, {
		...failClosedDetails(params.gateType, targetPath.path, true, { savedPath: result.savedPath }),
	});
}

export async function runPlannotatorReview(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: {
		diffType?: "uncommitted" | "staged" | "lastCommit" | "branch";
		prUrl?: string;
		timeoutMs?: number;
	},
) {
	const target = params.prUrl ?? params.diffType ?? "current-worktree";
	const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const response = await emitPlannotator<CodeReviewResult>(
		pi,
		"code-review",
		{
			cwd: ctx.cwd,
			diffType: params.diffType,
			prUrl: params.prUrl,
		},
		timeoutMs,
	);
	const handled = requireHandled(response, "code-review", target);
	if (!handled.ok) return textResult(handled.text, handled.details);

	const result = handled.result;
	if (!result.approved || result.exit) {
		const reason = result.exit ? "review session closed" : result.feedback || "not approved";
		return textResult(`Plannotator code review denied for ${target}: ${reason}`, {
			...failClosedDetails("code-review", target, false, {
				feedback: result.feedback,
				exit: result.exit,
				reviewId: result.reviewId,
				savedPath: result.savedPath,
			}),
		});
	}

	return textResult(`Plannotator code review approved for ${target}.`, {
		...failClosedDetails("code-review", target, true, {
			reviewId: result.reviewId,
			savedPath: result.savedPath,
		}),
	});
}

class EmptyVaultRender implements Component {
	render(): string[] {
		return [];
	}

	invalidate(): void {}
}

const emptyVaultRender = new EmptyVaultRender();

function commonTool() {
	return {
		renderShell: "self" as const,
		renderCall: () => emptyVaultRender,
		renderResult: () => emptyVaultRender,
	};
}

type VaultReadOp = "search" | "list" | "read" | "related" | "status";
type VaultWriteOp = "create" | "commit";
type VaultReviewOp = "gate" | "code";

function vaultReadArgs(params: Record<string, unknown>): string[] {
	const op = String(params.op ?? (params.query ? "search" : params.target ? "read" : "list")) as VaultReadOp;
	switch (op) {
		case "search": {
			const args = ["search", String(params.query ?? "")];
			args.push(...kindArgs(params.type as ArtifactType | undefined));
			if (params.archive) args.push("--archive");
			return args;
		}
		case "list": {
			const args = ["list", ...kindArgs(params.type as ArtifactType | undefined)];
			if (params.allProjects) args.push("--all");
			if (params.includeArchived) args.push("--archived");
			if (params.includeDives) args.push("--include-dives");
			return args;
		}
		case "read":
			return ["read", ...kindArgs(params.type as ArtifactType | undefined), String(params.target ?? "")];
		case "related": {
			const args = ["related", String(params.target ?? "")];
			if (params.archive) args.push("--archive");
			return args;
		}
		case "status":
			return ["status"];
		default:
			throw new Error("vault_read op must be search, list, read, related, or status");
	}
}

function vaultWriteArgs(params: Record<string, unknown>): string[] {
	const op = String(params.op ?? "") as VaultWriteOp;
	switch (op) {
		case "create":
			return buildVaultCreateArgs({
				type: params.type as ConcreteArtifactType,
				topic: String(params.topic ?? ""),
				tags: params.tags as string[] | undefined,
				source: params.source as string | undefined,
				dive: params.dive as boolean | undefined,
			});
		case "commit":
			return buildVaultCommitArgs({
				path: String(params.path ?? ""),
				message: params.message as string | undefined,
			});
		default:
			throw new Error("vault_write op must be create or commit");
	}
}

export default function vaultExtension(pi: ExtensionAPI) {
	pi.registerTool({
		...commonTool(),
		name: "vault_read",
		label: "Vault Read",
		description:
			"Read/search/list vault artifacts. op: search(query), list, read(target), related(target), status. type: all/research/plan/doc.",
		parameters: Type.Object({
			op: Type.Optional(Type.String({ description: "search, list, read, related, or status" })),
			query: Type.Optional(Type.String({ description: "Search query" })),
			target: Type.Optional(Type.String({ description: "Artifact stem/path or topic" })),
			type: Type.Optional(Type.String({ description: "all, research, plan, doc" })),
			archive: Type.Optional(Type.Boolean({ description: "Include archived results" })),
			allProjects: Type.Optional(Type.Boolean({ description: "List across projects" })),
			includeArchived: Type.Optional(Type.Boolean({ description: "List archived" })),
			includeDives: Type.Optional(Type.Boolean({ description: "List dives" })),
		}),
		async execute(_id, params: Record<string, unknown>, signal, _onUpdate, ctx) {
			return runVaultJson(ctx.cwd, vaultReadArgs(params), signal);
		},
	});

	pi.registerTool({
		...commonTool(),
		name: "vault_write",
		label: "Vault Write",
		description: "Create or commit vault artifacts. op: create(type, topic) or commit(path).",
		parameters: Type.Object({
			op: Type.String({ description: "create or commit" }),
			type: Type.Optional(Type.String({ description: "research, plan, doc" })),
			topic: Type.Optional(Type.String({ description: "Create topic" })),
			path: Type.Optional(Type.String({ description: "Commit path" })),
			message: Type.Optional(Type.String({ description: "Commit message" })),
			tags: Type.Optional(Type.Array(Type.String(), { description: "Create tags" })),
			source: Type.Optional(Type.String({ description: "Create source stem" })),
			dive: Type.Optional(Type.Boolean({ description: "Create research dive" })),
		}),
		async execute(_id, params: Record<string, unknown>, signal, _onUpdate, ctx) {
			return runVaultJson(ctx.cwd, vaultWriteArgs(params), signal);
		},
	});

	pi.registerTool({
		...commonTool(),
		name: "vault_review",
		label: "Vault Review",
		description: "Blocking Plannotator review. op: gate(targetPath, gateType) or code(diffType/prUrl). Fails closed.",
		parameters: Type.Object({
			op: Type.String({ description: "gate or code" }),
			targetPath: Type.Optional(
				Type.String({
					description: "Gate file path; relative paths are resolved from cwd and the blueprints vault",
				}),
			),
			gateType: Type.Optional(Type.String({ description: "research, plan, tests, docs, custom" })),
			diffType: Type.Optional(Type.String({ description: "uncommitted, staged, lastCommit, branch" })),
			prUrl: Type.Optional(Type.String({ description: "PR URL" })),
			title: Type.Optional(Type.String({ description: "Gate title" })),
			instructions: Type.Optional(Type.String({ description: "Gate instructions" })),
			timeoutMs: Type.Optional(Type.Number({ description: "Timeout ms; default 1h" })),
		}),
		async execute(_id, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
			const op = String(params.op ?? "") as VaultReviewOp;
			if (op === "gate") {
				return runPlannotatorGate(pi, {
					targetPath: String(params.targetPath ?? ""),
					gateType: params.gateType as GateType,
					title: params.title as string | undefined,
					instructions: params.instructions as string | undefined,
					timeoutMs: params.timeoutMs as number | undefined,
					cwd: ctx.cwd,
				});
			}
			if (op !== "code") throw new Error("vault_review op must be gate or code");
			return runPlannotatorReview(pi, ctx, {
				diffType: params.diffType as "uncommitted" | "staged" | "lastCommit" | "branch" | undefined,
				prUrl: params.prUrl as string | undefined,
				timeoutMs: params.timeoutMs as number | undefined,
			});
		},
	});
}
