import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configureImageCapabilities } from "../shared/image-capabilities";
import { toolRegistrarFor } from "../shared/tool-registry.ts";
import { registerToolResultImageRestore } from "../shared/tool-result-images";
import registerCodexAppsBridge from "./codex-apps";
import registerOpenAINativeCompaction from "./compaction/index";
import {
	buildGeneratedImageArtifactResult,
	createImageGenerationTool,
	createWebSearchTool,
	IMAGE_GENERATION_TOOL_NAME,
	rewriteNativeImageGenerationTool,
	rewriteNativeWebSearchTool,
	saveGeneratedImagesFromAssistantMessage,
	supportsNativeImageGeneration,
	supportsNativeWebSearch,
	WEB_SEARCH_ACTIVITY_MESSAGE_TYPE,
	WEB_SEARCH_TOOL_NAME,
} from "./native-tools";
import {
	createImageGenerationPresentation,
	createWebSearchPresentation,
	registerNativeActivityMessageRenderers,
} from "./native-tools-presentation";
import { createWebRunTool } from "./web-run";
import { createWebRunPresentation } from "./web-run-presentation";

function isCodexModel(model: ExtensionContext["model"] | undefined): boolean {
	const provider = model?.provider?.toLowerCase() ?? "";
	const id = model?.id?.toLowerCase() ?? "";
	return provider.includes("codex") || id.includes("codex");
}

function arraysEqual(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function normalizeResponsesIdPart(part: string): string {
	const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
	const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
	return normalized.replace(/_+$/, "");
}

function normalizeFunctionCallItemId(id: string): string {
	const normalized = normalizeResponsesIdPart(id);
	return normalized.startsWith("fc_") ? normalized : normalizeResponsesIdPart(`fc_${normalized}`);
}

function normalizeCustomToolCallItemId(id: string): string {
	const withoutFunctionPrefix = id.startsWith("fc_ctc_") ? id.slice("fc_".length) : id;
	const normalized = normalizeResponsesIdPart(withoutFunctionPrefix);
	return normalized.startsWith("ctc_") ? normalized : normalizeResponsesIdPart(`ctc_${normalized}`);
}

export function normalizeLegacyFunctionCallIds(payload: unknown): unknown {
	if (!payload || typeof payload !== "object") return payload;
	const input = (payload as { input?: unknown }).input;
	if (!Array.isArray(input)) return payload;

	let changed = false;
	const nextInput = input.map((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return item;
		const record = item as { type?: unknown; id?: unknown };
		if (record.type === "function_call" && typeof record.id === "string" && !record.id.startsWith("fc_")) {
			changed = true;
			return { ...record, id: normalizeFunctionCallItemId(record.id) };
		}
		if (record.type === "custom_tool_call" && typeof record.id === "string" && !record.id.startsWith("ctc_")) {
			changed = true;
			return { ...record, id: normalizeCustomToolCallItemId(record.id) };
		}
		return item;
	});

	return changed ? { ...(payload as object), input: nextInput } : payload;
}

export function normalizeCodexWebSocketError(message: AssistantMessage): AssistantMessage | undefined {
	if (message.provider !== "openai-codex") return undefined;
	if (message.stopReason !== "error") return undefined;
	if (message.errorMessage !== "WebSocket error") return undefined;
	return { ...message, errorMessage: "WebSocket connection error" };
}

export function isCodexWebSocketError(message: AssistantMessage): boolean {
	return (
		message.provider === "openai-codex" &&
		message.stopReason === "error" &&
		(message.errorMessage === "WebSocket error" ||
			message.errorMessage?.startsWith("WebSocket connection error") === true)
	);
}

export default async function codexNativeExtension(pi: ExtensionAPI) {
	// Pi 0.84 owns Codex transport, Responses replay, retry/recovery, diagnostics, usage, and
	// constrainedSampling conversion. This composition root owns local tools and lifecycle only.
	configureImageCapabilities();
	registerToolResultImageRestore(pi);
	registerOpenAINativeCompaction(pi);
	await registerCodexAppsBridge(pi);
	const registerCodexTool = toolRegistrarFor(pi);
	registerCodexTool({ ...createImageGenerationTool(), ...createImageGenerationPresentation() });
	registerCodexTool({ ...createWebSearchTool(), ...createWebSearchPresentation() });
	registerCodexTool({ ...createWebRunTool(), ...createWebRunPresentation() });
	registerNativeActivityMessageRenderers(pi);

	const applyToolPolicy = (ctx?: ExtensionContext) => {
		if (!ctx) return;
		const active = pi.getActiveTools();
		const codexModel = isCodexModel(ctx.model);
		let next = active;

		if (supportsNativeWebSearch(ctx.model) && !next.includes(WEB_SEARCH_TOOL_NAME)) {
			next = [...next, WEB_SEARCH_TOOL_NAME];
		}

		if (codexModel && supportsNativeImageGeneration(ctx.model) && !next.includes(IMAGE_GENERATION_TOOL_NAME)) {
			next = [...next, IMAGE_GENERATION_TOOL_NAME];
		}

		if (!supportsNativeWebSearch(ctx.model) && next.includes(WEB_SEARCH_TOOL_NAME)) {
			next = next.filter((toolName) => toolName !== WEB_SEARCH_TOOL_NAME);
		}

		if (!codexModel && next.includes(IMAGE_GENERATION_TOOL_NAME)) {
			next = next.filter((toolName) => toolName !== IMAGE_GENERATION_TOOL_NAME);
		}

		if (!arraysEqual(active, next)) pi.setActiveTools(next);
	};

	pi.on("session_start", (_event, ctx) => {
		applyToolPolicy(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		applyToolPolicy(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		applyToolPolicy(ctx);
	});

	const queueImageProvenance = (artifactResult: string) => {
		pi.sendMessage(
			{
				customType: "codex-image-generation-provenance",
				content: artifactResult,
				display: false,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	};

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const message = normalizeCodexWebSocketError(event.message);
		const baseMessage = message ?? event.message;
		const savedImages = await saveGeneratedImagesFromAssistantMessage(ctx.cwd, baseMessage);
		if (savedImages.length > 0) {
			const artifactResult = buildGeneratedImageArtifactResult(savedImages);
			queueImageProvenance(artifactResult);
			return {
				message: {
					...baseMessage,
					content: [...baseMessage.content, { type: "text", text: artifactResult }],
				},
			};
		}
		for (const block of baseMessage.content as Array<{ type?: string; item?: { artifact_result?: unknown } }>) {
			const artifactResult = block.item?.artifact_result;
			if (block.type === "image_generation_call" && typeof artifactResult === "string") {
				queueImageProvenance(artifactResult);
				break;
			}
		}
		if (message) return { message };
	});

	pi.on("context", (event) => ({
		messages: event.messages.filter(
			(message) =>
				(message.role !== "custom" || message.customType !== WEB_SEARCH_ACTIVITY_MESSAGE_TYPE) &&
				(message.role !== "assistant" || !isCodexWebSocketError(message)),
		),
	}));

	pi.on("before_agent_start", (_event, ctx) => {
		applyToolPolicy(ctx);
	});

	pi.on("before_provider_request", async (event, ctx) =>
		normalizeLegacyFunctionCallIds(
			rewriteNativeImageGenerationTool(rewriteNativeWebSearchTool(event.payload, ctx.model), ctx.model),
		),
	);
}
