import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type {
	NestedToolAdapter,
	NestedToolDetails,
	NestedToolInput,
	NestedToolInvocationContext,
	NestedToolKind,
	NestedToolScope,
	NestedToolScopeEntry,
} from "./nested-tools.ts";

import type { NestedToolInput, NestedToolInvocationContext, NestedToolKind } from "./nested-tools.ts";

export type TraceValue = null | boolean | number | string | TraceValue[] | { [key: string]: TraceValue };

export interface NestedToolPreflightCall {
	toolName: string;
	input: NestedToolInput;
	cwd: string;
	toolCallId: string;
	extensionContext: ExtensionContext;
	signal: AbortSignal;
}

export type NestedToolPreflightResult = { block: true; reason: string } | { block?: false };
export type NestedToolPreflight = (
	call: NestedToolPreflightCall,
) => undefined | NestedToolPreflightResult | Promise<undefined | NestedToolPreflightResult>;

export type RuntimeContentItem =
	| { type: "input_text"; text: string }
	| {
			type: "input_image";
			image_url: string;
			detail?: "auto" | "low" | "high" | "original" | null;
	  }
	| { type: "input_audio"; audio_url: string };

export interface NestedToolTrace {
	version: 1;
	id: string;
	name: string;
	kind: NestedToolKind;
	input: unknown;
	status: "running" | "done" | "error";
	startedAtMs: number;
	durationMs?: number;
	result?: NestedToolResult;
	/** Programmatic value returned to nested JavaScript, bounded for duplicate-output detection. */
	value?: TraceValue;
	error?: string;
}

export interface NestedToolResult {
	content: TraceValue[];
	details?: TraceValue;
}

export interface CodeModeToolDetails {
	version: 1;
	tool: "exec" | "wait";
	status: "running" | "yielded" | "terminated" | "completed" | "failed";
	cellId: string;
	isError: boolean;
	input: TraceValue;
	timing: { startedAtMs: number; durationMs: number };
	maxOutputTokens: number;
	output: {
		textChars: number;
		imageCount: number;
		imageChars: number;
		audioCount: number;
		audioChars: number;
		textTruncated: boolean;
		imagesOmitted: number;
	};
	nestedCalls: NestedToolTrace[];
	scriptError?: string;
	missingCell?: boolean;
	notification?: { text: string; truncated: boolean };
}

type RuntimeOutcome =
	| { kind: "yielded"; cellId: string; contentItems: RuntimeContentItem[] }
	| { kind: "terminated"; cellId: string; contentItems: RuntimeContentItem[] }
	| { kind: "result"; cellId: string; contentItems: RuntimeContentItem[]; errorText?: string; missingCell?: boolean };

export type RuntimeResponse = RuntimeOutcome & { nestedCalls?: NestedToolTrace[] };

export interface ToolExecutionContext extends NestedToolInvocationContext {
	onUpdate?: (result: AgentToolResult<unknown>) => void;
	presentation?: {
		tool: "exec" | "wait";
		input: unknown;
		startedAtMs: number;
		maxOutputTokens: number;
	};
}
