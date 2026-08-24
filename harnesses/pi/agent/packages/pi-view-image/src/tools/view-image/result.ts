import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export interface ViewImageNativeOutput {
	data: string;
	mimeType: string;
	detail: "high" | "original";
	path: string;
	width: number;
	height: number;
	bytes: number;
}

export interface ViewImageContent {
	type: "image";
	data: string;
	mimeType: string;
	detail: "high" | "original";
}

export interface ViewImageDetails {
	version: 1;
	tool: "view_image";
	status: "success";
	input: { path: string; detail: "high" | "original" };
	image: { path: string; mimeType: string; width: number; height: number; bytes: number };
	timing: { durationMs: number };
}

export function createViewImageResult(
	input: { path: string; detail: "high" | "original" },
	output: ViewImageNativeOutput,
	durationMs: number,
): AgentToolResult<ViewImageDetails> {
	const content: ViewImageContent = {
		type: "image",
		data: output.data,
		mimeType: output.mimeType,
		detail: output.detail,
	};
	return {
		content: [content],
		details: {
			version: 1,
			tool: "view_image",
			status: "success",
			input,
			image: {
				path: output.path,
				mimeType: output.mimeType,
				width: output.width,
				height: output.height,
				bytes: output.bytes,
			},
			timing: { durationMs },
		},
	};
}
