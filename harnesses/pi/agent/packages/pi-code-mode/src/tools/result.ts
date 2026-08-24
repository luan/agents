import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { CodeModeToolDetails, RuntimeContentItem, RuntimeResponse } from "../protocol/types.ts";
import { sanitizeTraceInput } from "../runtime/trace-values.ts";

const MAX_OUTPUT_IMAGE_COUNT = 4;
const MAX_OUTPUT_IMAGE_CHARS = 16 * 1024 * 1024;
const MAX_OUTPUT_AUDIO_COUNT = 4;
const MAX_OUTPUT_AUDIO_CHARS = 80 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 100_000;

interface AudioContent {
	type: "audio";
	data: string;
	mimeType: string;
}

type CodeModeContent = AgentToolResult<unknown>["content"][number] | AudioContent;

export function toCodeModeToolResult(
	response: RuntimeResponse & { maxOutputTokens?: number },
	options: {
		requestedTokens?: number;
		tool?: "exec" | "wait";
		input?: unknown;
		startedAtMs?: number;
	} = {},
): AgentToolResult<CodeModeToolDetails> {
	const tool = options.tool ?? "exec";
	const startedAtMs = options.startedAtMs ?? Date.now();
	const scriptError = response.kind === "result" ? response.errorText : undefined;
	const isError = Boolean(scriptError || ("missingCell" in response && response.missingCell));
	const status = scriptError
		? `Script error: ${scriptError}`
		: response.kind === "yielded"
			? `Still running (exec cell "${response.cellId}"). Use wait near expected completion.`
			: response.kind === "terminated"
				? "Script terminated"
				: "Script completed";
	let imageChars = 0;
	let imageCount = 0;
	let audioChars = 0;
	let audioCount = 0;
	let imagesOmitted = 0;
	let textChars = 0;
	const content: CodeModeContent[] = [];
	for (const item of response.contentItems) {
		const next = toPiContent(item);
		if (!next) continue;
		if (next.type === "text") {
			textChars += next.text.length;
			content.push(next);
			continue;
		}
		if (next.type === "audio") {
			if (audioCount >= MAX_OUTPUT_AUDIO_COUNT || audioChars + next.data.length > MAX_OUTPUT_AUDIO_CHARS) continue;
			audioCount++;
			audioChars += next.data.length;
			content.push(next);
			continue;
		}
		if (imageCount >= MAX_OUTPUT_IMAGE_COUNT || imageChars + next.data.length > MAX_OUTPUT_IMAGE_CHARS) {
			imagesOmitted++;
			continue;
		}
		imageCount++;
		imageChars += next.data.length;
		content.push(next);
	}
	const maxTokens = Math.min(
		MAX_OUTPUT_TOKENS,
		Math.max(1, options.requestedTokens ?? response.maxOutputTokens ?? 10_000),
	);
	const maxTextChars = maxTokens * 4;
	const nestedSummary = response.nestedCalls?.length
		? response.nestedCalls
				.map((trace) => {
					const verb = trace.status === "running" ? "Running" : trace.status === "error" ? "Failed" : "Ran";
					return `• ${verb} ${trace.name}`;
				})
				.join("\n")
		: undefined;
	const details: CodeModeToolDetails = {
		version: 1,
		tool,
		status: isError ? "failed" : response.kind === "result" ? "completed" : response.kind,
		cellId: response.cellId,
		isError,
		input: sanitizeTraceInput(options.input),
		timing: { startedAtMs, durationMs: Date.now() - startedAtMs },
		maxOutputTokens: maxTokens,
		output: {
			textChars,
			imageCount,
			imageChars,
			audioCount,
			audioChars,
			textTruncated: textChars > maxTextChars,
			imagesOmitted,
		},
		nestedCalls: response.nestedCalls ?? [],
		...(scriptError ? { scriptError } : {}),
		...(response.kind === "result" && response.missingCell ? { missingCell: true } : {}),
	};
	const resultContent: CodeModeContent[] = [
		...(nestedSummary ? [{ type: "text" as const, text: nestedSummary }] : []),
		{ type: "text", text: status },
		...truncateTextContent(content, maxTextChars),
	];
	return {
		// type-boundary: Pi 0.84.2 types omit audio content, while the Codex provider adapter below serializes it.
		content: resultContent as AgentToolResult<CodeModeToolDetails>["content"],
		details,
	};
}

function toPiContent(item: RuntimeContentItem) {
	if (item.type === "input_text" && typeof item.text === "string") return { type: "text" as const, text: item.text };
	if (item.type === "input_image" && typeof item.image_url === "string") {
		const match = item.image_url.match(/^data:([^;,]+);base64,(.+)$/s);
		if (match) return { type: "image" as const, mimeType: match[1]!, data: match[2]! };
	}
	if (item.type === "input_audio" && typeof item.audio_url === "string") {
		const match = item.audio_url.match(/^data:([^;,]+);base64,(.+)$/s);
		if (match) return { type: "audio" as const, mimeType: match[1]!, data: match[2]! };
	}
	return undefined;
}

function truncateTextContent(content: readonly CodeModeContent[], maxChars: number): CodeModeContent[] {
	let remaining = maxChars;
	const output: CodeModeContent[] = [];
	for (const item of content) {
		if (item.type !== "text" || typeof item.text !== "string") {
			output.push(item);
			continue;
		}
		if (remaining <= 0) continue;
		if (item.text.length <= remaining) {
			remaining -= item.text.length;
			output.push(item);
		} else {
			output.push({ type: "text", text: `${item.text.slice(0, remaining)}\n[Output truncated]` });
			remaining = 0;
		}
	}
	return output;
}
