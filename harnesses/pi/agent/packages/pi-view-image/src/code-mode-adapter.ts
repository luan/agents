import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { type CodeModeToolDetails, registerCodeModeFunctionTool } from "pi-code-mode/sdk";
import type { createViewImageTool } from "./tools/view-image/definition.ts";
import type { ViewImageContent } from "./tools/view-image/result.ts";

type ViewImageTool = ReturnType<typeof createViewImageTool>;

export function registerViewImageCodeModeAdapter(tool: ViewImageTool): () => void {
	return registerCodeModeFunctionTool(tool, {
		outputSchema: {
			type: "object",
			properties: {
				image_url: { type: "string", description: "Data URL for the loaded image." },
				detail: {
					type: "string",
					enum: ["high", "original"],
					description:
						"Image detail hint returned by view_image. Returns `high` for default resized behavior or `original` when original resolution is preserved.",
				},
			},
			required: ["image_url", "detail"],
			additionalProperties: false,
		},
		resultValue: codeModeImageResult,
	});
}

export function codeModeImageResult(result: AgentToolResult<CodeModeToolDetails>): {
	image_url: string;
	detail: "high" | "original";
} {
	const image = result.content.find((item): item is ViewImageContent => item.type === "image");
	if (!image) throw new Error("view_image returned no image content");
	return {
		image_url: `data:${image.mimeType};base64,${image.data}`,
		detail: image.detail,
	};
}
