import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { type CodeModeToolDetails, registerCodeModeFunctionTool } from "@luan.sh/pi-code-mode/sdk";
import type { createViewImageTool } from "./tools/view-image/definition.ts";
import type { ViewImageContent } from "./tools/view-image/result.ts";

type ViewImageTool = ReturnType<typeof createViewImageTool>;

export function registerViewImageCodeModeAdapter(tool: ViewImageTool): () => void {
	return registerCodeModeFunctionTool(tool, {
		outputSchema: {
			anyOf: [
				{
					type: "object",
					properties: { image_url: { type: "string" }, detail: { type: "string", enum: ["high", "original"] } },
					required: ["image_url", "detail"],
					additionalProperties: false,
				},
				{
					type: "object",
					properties: { description: { type: "string" } },
					required: ["description"],
					additionalProperties: false,
				},
			],
		},
		resultValue: codeModeImageResult,
	});
}

export function codeModeImageResult(result: AgentToolResult<CodeModeToolDetails>):
	| {
			image_url: string;
			detail: "high" | "original";
	  }
	| { description: string } {
	const image = result.content.find((item): item is ViewImageContent => item.type === "image");
	if (!image) {
		const description = result.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		if (description) return { description };
		throw new Error("view_image returned no image or description");
	}
	return {
		image_url: `data:${image.mimeType};base64,${image.data}`,
		detail: image.detail,
	};
}
