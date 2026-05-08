import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
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

export async function runPlannotatorGate(
	pi: ExtensionAPI,
	params: {
		targetPath: string;
		gateType: GateType;
		title?: string;
		instructions?: string;
		timeoutMs?: number;
	},
) {
	const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const response = await emitPlannotator<AnnotationResult>(
		pi,
		"annotate",
		{
			filePath: params.targetPath,
			gate: true,
			mode: "annotate",
			title: params.title,
			instructions: params.instructions,
		},
		timeoutMs,
	);
	const handled = requireHandled(response, params.gateType, params.targetPath);
	if (!handled.ok) return textResult(handled.text, handled.details);

	const result = handled.result;
	if (!result.approved || result.exit) {
		const reason = result.exit ? "review session closed" : result.feedback || "not approved";
		return textResult(`Plannotator ${params.gateType} gate denied for ${params.targetPath}: ${reason}`, {
			...failClosedDetails(params.gateType, params.targetPath, false, {
				feedback: result.feedback,
				exit: result.exit,
				savedPath: result.savedPath,
			}),
		});
	}

	return textResult(`Plannotator ${params.gateType} gate approved for ${params.targetPath}.`, {
		...failClosedDetails(params.gateType, params.targetPath, true, { savedPath: result.savedPath }),
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

export default function vaultExtension(pi: ExtensionAPI) {
	pi.registerTool({
		...commonTool(),
		name: "vault_search",
		label: "Vault Search",
		description: "Search blueprints vault artifacts via ct vault search.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			type: Type.Optional(Type.String({ description: "Artifact type: all, research, plan, doc" })),
			archive: Type.Optional(Type.Boolean({ description: "Include archived artifacts" })),
			allProjects: Type.Optional(Type.Boolean({ description: "Search all projects" })),
			limit: Type.Optional(Type.Number({ description: "Maximum results to return" })),
		}),
		async execute(_id, params: Record<string, unknown>, signal, _onUpdate, ctx) {
			const args = ["search", String(params.query ?? "")];
			args.push(...kindArgs(params.type as ArtifactType | undefined));
			if (params.archive) args.push("--archive");
			if (!params.allProjects) {
				// `ct vault search` defaults to all projects unless project is specified; leave broad for now.
			}
			return runVaultJson(ctx.cwd, args, signal);
		},
	});

	pi.registerTool({
		...commonTool(),
		name: "vault_list",
		label: "Vault List",
		description: "List blueprints vault artifacts via ct vault list.",
		parameters: Type.Object({
			type: Type.Optional(Type.String({ description: "Artifact type: all, research, plan, doc" })),
			allProjects: Type.Optional(Type.Boolean({ description: "Show artifacts from all projects" })),
			includeArchived: Type.Optional(Type.Boolean({ description: "Show archived artifacts" })),
			includeDives: Type.Optional(Type.Boolean({ description: "Include dive files" })),
		}),
		async execute(_id, params: Record<string, unknown>, signal, _onUpdate, ctx) {
			const args = ["list", ...kindArgs(params.type as ArtifactType | undefined)];
			if (params.allProjects) args.push("--all");
			if (params.includeArchived) args.push("--archived");
			if (params.includeDives) args.push("--include-dives");
			return runVaultJson(ctx.cwd, args, signal);
		},
	});

	pi.registerTool({
		...commonTool(),
		name: "vault_read",
		label: "Vault Read",
		description: "Read a blueprints vault artifact via ct vault read.",
		parameters: Type.Object({
			stemOrPath: Type.String({ description: "Artifact stem or path" }),
			type: Type.Optional(Type.String({ description: "Artifact type: all, research, plan, doc" })),
		}),
		async execute(_id, params: Record<string, unknown>, signal, _onUpdate, ctx) {
			return runVaultJson(
				ctx.cwd,
				["read", ...kindArgs(params.type as ArtifactType | undefined), String(params.stemOrPath)],
				signal,
			);
		},
	});

	pi.registerTool({
		...commonTool(),
		name: "vault_related",
		label: "Vault Related",
		description: "Find related blueprints vault artifacts by topic overlap.",
		parameters: Type.Object({
			topicOrStem: Type.String({ description: "Topic or artifact stem" }),
			archive: Type.Optional(Type.Boolean({ description: "Include archived artifacts" })),
		}),
		async execute(_id, params: Record<string, unknown>, signal, _onUpdate, ctx) {
			const args = ["related", String(params.topicOrStem)];
			if (params.archive) args.push("--archive");
			return runVaultJson(ctx.cwd, args, signal);
		},
	});

	pi.registerTool({
		...commonTool(),
		name: "vault_status",
		label: "Vault Status",
		description: "Show blueprints vault status.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal, _onUpdate, ctx) {
			return runVaultJson(ctx.cwd, ["status"], signal);
		},
	});

	pi.registerTool({
		...commonTool(),
		name: "vault_create",
		label: "Vault Create",
		description: "Create a new blueprints vault artifact shell and return its path.",
		parameters: Type.Object({
			type: Type.String({ description: "Artifact type: research, plan, doc" }),
			topic: Type.String({ description: "Artifact topic" }),
			tags: Type.Optional(Type.Array(Type.String(), { description: "Additional tags" })),
			source: Type.Optional(Type.String({ description: "Source artifact stem" })),
			dive: Type.Optional(Type.Boolean({ description: "Create a research dive" })),
		}),
		async execute(_id, params: Record<string, unknown>, signal, _onUpdate, ctx) {
			return runVaultJson(
				ctx.cwd,
				buildVaultCreateArgs({
					type: params.type as ConcreteArtifactType,
					topic: String(params.topic),
					tags: params.tags as string[] | undefined,
					source: params.source as string | undefined,
					dive: params.dive as boolean | undefined,
				}),
				signal,
			);
		},
	});

	pi.registerTool({
		...commonTool(),
		name: "vault_commit",
		label: "Vault Commit",
		description: "Commit and push edits to a blueprints vault artifact.",
		parameters: Type.Object({
			path: Type.String({ description: "Vault artifact path" }),
			message: Type.Optional(Type.String({ description: "Optional commit message" })),
		}),
		async execute(_id, params: Record<string, unknown>, signal, _onUpdate, ctx) {
			return runVaultJson(
				ctx.cwd,
				buildVaultCommitArgs({ path: String(params.path), message: params.message as string | undefined }),
				signal,
			);
		},
	});

	pi.registerTool({
		...commonTool(),
		name: "vault_plannotator_gate",
		label: "Vault Plannotator Gate",
		description: "Open a blocking Plannotator gate for a markdown/vault artifact. Fails closed unless approved.",
		parameters: Type.Object({
			targetPath: Type.String({ description: "Markdown/vault artifact path to gate" }),
			gateType: Type.String({ description: "Gate type: research, plan, tests, docs, custom" }),
			title: Type.Optional(Type.String({ description: "Optional review title" })),
			instructions: Type.Optional(Type.String({ description: "Optional reviewer instructions" })),
			timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds; defaults to 1 hour" })),
		}),
		async execute(_id, params: Record<string, unknown>) {
			return runPlannotatorGate(pi, {
				targetPath: String(params.targetPath),
				gateType: params.gateType as GateType,
				title: params.title as string | undefined,
				instructions: params.instructions as string | undefined,
				timeoutMs: params.timeoutMs as number | undefined,
			});
		},
	});

	pi.registerTool({
		...commonTool(),
		name: "vault_plannotator_review",
		label: "Vault Plannotator Review",
		description:
			"Open a blocking Plannotator code review for the current worktree or PR. Fails closed unless approved.",
		parameters: Type.Object({
			diffType: Type.Optional(Type.String({ description: "Diff type: uncommitted, staged, lastCommit, branch" })),
			prUrl: Type.Optional(Type.String({ description: "Optional pull request URL" })),
			timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds; defaults to 1 hour" })),
		}),
		async execute(_id, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
			return runPlannotatorReview(pi, ctx, {
				diffType: params.diffType as "uncommitted" | "staged" | "lastCommit" | "branch" | undefined,
				prUrl: params.prUrl as string | undefined,
				timeoutMs: params.timeoutMs as number | undefined,
			});
		},
	});
}
