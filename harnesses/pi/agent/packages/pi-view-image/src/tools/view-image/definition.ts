import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import { resolveViewImageBinary } from "../../native/binary.ts";
import { runViewImageBinary } from "../../native/view-image.ts";
import { renderViewImageCall, renderViewImageResult } from "./presentation.ts";
import { createViewImageResult, type ViewImageDetails } from "./result.ts";

const UNSUPPORTED_MESSAGE = "view_image is not allowed because the current model does not support image inputs";

interface ViewImageParams {
	path: string;
	detail: "high" | "original";
}

interface ViewImageModel {
	provider?: string;
	input?: readonly string[];
	compat?: object;
}

type ViewImageParameters = ReturnType<typeof createViewImageParameters>;

function createViewImageParameters() {
	const properties: Record<string, TSchema> = {
		path: Type.String({ description: "Local filesystem path to an image file." }),
		detail: Type.Optional(
			Type.Union([Type.Literal("high"), Type.Literal("original")], {
				description: "Image detail level. Defaults to `high`; use `original` to preserve exact resolution.",
			}),
		),
	};
	return Type.Object(properties);
}

export function parseViewImageParams(params: object): ViewImageParams {
	const path = Reflect.get(params, "path");
	if (typeof path !== "string" || !path.trim()) throw new Error("view_image requires a non-empty string 'path'");
	const detail = Reflect.get(params, "detail");
	if (detail !== undefined && detail !== null && detail !== "high" && detail !== "original") {
		throw new Error(`view_image.detail only supports \`high\` or \`original\`, got \`${String(detail)}\``);
	}
	return { path: path.startsWith("@") ? path.slice(1) : path, detail: detail === "original" ? "original" : "high" };
}

// type-boundary: Pi supplies unvalidated model tool arguments; the TypeBox schema validates this prepared record next.
type UntrustedViewImageArguments = unknown;

function prepareViewImageArguments(args: UntrustedViewImageArguments): Record<string, unknown> {
	if (!args || typeof args !== "object" || Array.isArray(args)) return {};
	const record = args as Record<string, unknown>;
	if (Reflect.has(record, "path")) return record;
	const alias = Reflect.has(record, "file_path") ? Reflect.get(record, "file_path") : Reflect.get(record, "image_path");
	return alias === undefined ? record : { ...record, path: alias };
}

export function supportsViewImageInputs(model: { input?: readonly string[] } | undefined): boolean {
	return Array.isArray(model?.input) && model.input.includes("image");
}

export function supportsOriginalImageDetail(model: ViewImageModel | undefined): boolean {
	if (!supportsViewImageInputs(model)) return false;
	return (
		model?.provider !== "openai-codex" ||
		(model.compat !== undefined && Reflect.get(model.compat, "supportsImageDetailOriginal") === true)
	);
}

export function configureViewImageToolForModel(
	tool: ReturnType<typeof createViewImageTool>,
	model: ViewImageModel | undefined,
): void {
	const properties = tool.parameters.properties as Record<string, TSchema>;
	if (supportsOriginalImageDetail(model)) {
		properties.detail = createViewImageParameters().properties.detail!;
	} else {
		delete properties.detail;
	}
}

export function effectiveViewImageParams(params: object, model: ViewImageModel | undefined): ViewImageParams {
	const requested = parseViewImageParams(params);
	return requested.detail === "original" && !supportsOriginalImageDetail(model)
		? { ...requested, detail: "high" }
		: requested;
}

export function createViewImageTool(): ToolDefinition<ViewImageParameters, ViewImageDetails> {
	return {
		name: "view_image",
		label: "view_image",
		description:
			"View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.",
		parameters: createViewImageParameters(),
		prepareArguments: prepareViewImageArguments,
		renderShell: "self",
		renderCall(args, theme, context) {
			return renderViewImageCall(args, theme, context);
		},
		renderResult(result, _options, theme, context) {
			return renderViewImageResult(result, theme, context);
		},
		async execute(_toolCallId, params, signal, _onUpdate, context) {
			if (!supportsViewImageInputs(context.model)) throw new Error(UNSUPPORTED_MESSAGE);
			const input = effectiveViewImageParams(params, context.model);
			const startedAt = performance.now();
			const output = await runViewImageBinary(resolveViewImageBinary(), input, context.cwd, signal);
			return createViewImageResult(input, output, Math.max(0, Math.round(performance.now() - startedAt)));
		},
	};
}
