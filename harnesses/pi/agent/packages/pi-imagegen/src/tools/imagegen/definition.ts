import { createImageGenerationTool, imagegenCodeModeResult } from "@howaboua/pi-codex-imagegen";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { CodeModeToolDetails } from "@luan.sh/pi-code-mode/sdk";
import { Image, Text } from "@earendil-works/pi-tui";
import { ComponentStack, tuiTheme } from "@luan.sh/pi-libtui";
import { ToolActivity, toolCallPreview, settleToolCallPreview } from "@luan.sh/pi-libtui/tool";
export function imagegenResult(result: AgentToolResult<CodeModeToolDetails>): {
	image_url: string;
	output_hint: string;
} {
	// type-boundary: upstream result helper returns unknown; validate its public image result immediately.
	const value = imagegenCodeModeResult(result);
	if (!value || typeof value !== "object" || !("image_url" in value) || typeof value.image_url !== "string")
		throw new Error(typeof value === "string" ? value : "Image generation returned no readable artifact");
	return {
		image_url: value.image_url,
		output_hint: "output_hint" in value && typeof value.output_hint === "string" ? value.output_hint : "",
	};
}
export function createImagegenTool() {
	const tool = createImageGenerationTool({
		allowCodexProviderFallback: true,
		customRendering: false,
		promptSnippet: false,
	});
	return {
		...tool,
		async execute(...args: Parameters<typeof tool.execute>) {
			const result = await tool.execute(...args);
			return {
				...result,
				details: { ...result.details, version: 1, tool: "image_gen__imagegen", status: "succeeded" },
			};
		},
		name: "image_gen__imagegen",
		label: "Generate image",
		renderShell: "self" as const,
		description:
			"Generate or edit images using Codex credentials. Omit image selectors for a new image. For edits, provide referenced_image_paths or num_last_images_to_include, never both.",
		promptGuidelines: [
			"Inspect edit targets first. In Code Mode call generatedImage(await tools.image_gen__imagegen(...)); never print or serialize base64 image data.",
		],
		renderCall: ((args, theme, context) => {
			const sharedTheme = compatibleSharedTheme(theme);
			return context.executionStarted
				? new ComponentStack()
				: toolCallPreview(
						context.state,
						new ToolActivity({
							theme: sharedTheme,
							requestRender: context.invalidate,
							view: { action: { verb: "Generate image", detail: args.prompt, status: "queued" } },
						}),
					);
		}) satisfies NonNullable<typeof tool.renderCall>,
		renderResult: ((result, options, theme, context) => {
			settleToolCallPreview(context.state);
			const sharedTheme = compatibleSharedTheme(theme);
			const text = result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			return ToolActivity.reuse(context.lastComponent, {
				theme: sharedTheme,
				requestRender: context.invalidate,
				view: {
					action: {
						verb: context.isError ? "Image generation failed" : "Generated image",
						status: context.isError ? "failed" : "succeeded",
						detail: result.details?.path,
					},
					mode: options.expanded ? "full" : "preview",
					...(context.isError
						? { failure: text }
						: {
								payload: {
									kind: "component" as const,
									preview: new ComponentStack([
										new Text(text, 0, 0),
										...(context.showImages ? result.content.filter((part) => part.type === "image") : []).map(
											(part) =>
												new Image(
													part.data,
													part.mimeType,
													{ fallbackColor: (text) => tuiTheme(sharedTheme).fg("text.muted", text) },
													{ maxHeightCells: 16 },
												),
										),
									]),
								},
							}),
				},
			});
		}) satisfies NonNullable<typeof tool.renderResult>,
	};
}

type SharedTheme = ConstructorParameters<typeof ToolActivity>[0]["theme"];
// type-boundary: Pi Theme comes from the upstream package's peer installation;
// compatibleSharedTheme validates the public methods used by pi-libtui.
type ExternalThemeBoundary = unknown;

function compatibleSharedTheme(
	theme: Parameters<NonNullable<ReturnType<typeof createImageGenerationTool>["renderCall"]>>[1],
): SharedTheme {
	const candidate: ExternalThemeBoundary = theme;
	if (
		!candidate ||
		typeof candidate !== "object" ||
		!("bold" in candidate) ||
		typeof candidate.bold !== "function" ||
		!("getFgAnsi" in candidate) ||
		typeof candidate.getFgAnsi !== "function" ||
		!("getBgAnsi" in candidate) ||
		typeof candidate.getBgAnsi !== "function"
	)
		throw new TypeError("Imagegen received an incompatible Pi theme");
	return candidate as SharedTheme;
}
