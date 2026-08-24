import type { NestedToolAdapter } from "../../protocol/types.ts";

// Kept aligned with codex-rs/code-mode-protocol/src/description.rs.
function execDescription(defaultYieldTimeMs: number, defaultOutputTokens: number, supportsAudio: boolean): string {
	const audio = supportsAudio
		? "\n- `audio(audioUrlOrItem: string | { audio_url: string } | AudioContent)`: Appends an audio item. `audio_url` should be a base64-encoded `data:` URL. To forward an MCP tool audio block, pass an individual `AudioContent` block from `result.content`, for example `audio(result.content[0])`."
		: "";
	return `Run JavaScript code to orchestrate/compose tool calls
- Evaluates the provided JavaScript code in a fresh V8 isolate as an async module.
- All nested tools are available on the global \`tools\` object, for example \`await tools.exec_command(...)\`. Tool names are exposed as normalized JavaScript identifiers, for example \`await tools.mcp__ologs__get_profile(...)\`.
- Nested tool methods take either a string or an object as their input argument.
- Nested tools return either an object or a string, based on the description.
- Runs raw JavaScript -- no Node, no file system, no network access, no console.
- Accepts raw JavaScript source text, not JSON, quoted strings, or markdown code fences.
- You may optionally start the tool input with a first-line pragma like \`// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}\`.
- \`yield_time_ms\` asks \`exec\` to yield early if the script is still running. Defaults to ${defaultYieldTimeMs} ms.
- \`max_output_tokens\` sets the token budget for direct \`exec\` results. Defaults to ${defaultOutputTokens} tokens.
- When the JS code is fully evaluated, the isolate's lifetime ends and unawaited promises are silently discarded.

- Global helpers:
- \`exit()\`: Immediately ends the current script successfully (like an early return from the top level).
- \`text(value: string | number | boolean | undefined | null)\`: Appends a text item. Non-string values are stringified with \`JSON.stringify(...)\` when possible.
- \`image(imageUrlOrItem: string | { image_url: string; detail?: "auto" | "low" | "high" | "original" | null } | ImageContent, detail?: "auto" | "low" | "high" | "original" | null)\`: Appends an image item. \`image_url\` should be a base64-encoded \`data:\` URL. To forward an MCP tool image, pass an individual \`ImageContent\` block from \`result.content\`, for example \`image(result.content[0])\`. MCP image blocks may request detail with \`_meta: { "codex/imageDetail": "original" }\`. When provided, the second \`detail\` argument overrides any detail embedded in the first argument.${audio}
- \`generatedImage(result: { image_url: string; output_hint?: string })\`: Appends an image-generation result and its optional output hint. HTTP(S) URLs are not supported.
- \`store(key: string, value: any)\`: stores a serializable value under a string key for later \`exec\` calls in the same session.
- \`load(key: string)\`: returns the stored value for a string key, or \`undefined\` if it is missing.
- \`notify(value: string | number | boolean | undefined | null)\`: immediately injects an extra \`custom_tool_call_output\` for the current \`exec\` call. Values are stringified like \`text(...)\`.
- \`setTimeout(callback: () => void, delayMs?: number)\`: schedules a callback to run later and returns a timeout id. Pending timeouts do not keep \`exec\` alive by themselves; await an explicit promise if you need to wait for one.
- \`clearTimeout(timeoutId?: number)\`: cancels a timeout created by \`setTimeout\`.
- \`ALL_TOOLS\`: metadata for the enabled nested tools as \`{ name, description }\` entries.
- \`yield_control()\`: yields the accumulated output to the model immediately while the script keeps running.`;
}

export function buildExecDescription(
	adapters: readonly NestedToolAdapter[],
	defaults: { defaultExecYieldMs?: number; defaultOutputTokens?: number; supportsAudio?: boolean } = {},
): string {
	const sections = [
		execDescription(
			defaults.defaultExecYieldMs ?? 30_000,
			defaults.defaultOutputTokens ?? 10_000,
			defaults.supportsAudio ?? false,
		),
	];
	for (const adapter of adapters) {
		const globalName = normalizeIdentifier(adapter.name);
		const heading =
			globalName === adapter.name ? `### \`${globalName}\`` : `### \`${globalName}\` (\`${adapter.name}\`)`;
		sections.push(`${heading}\n${renderCodeModeToolDescription(adapter).trim()}`);
	}
	return sections.join("\n\n");
}

export function renderCodeModeToolDescription(adapter: NestedToolAdapter): string {
	const inputName = adapter.kind === "freeform" ? "input" : "args";
	const inputType = adapter.kind === "freeform" ? "string" : renderSchema(adapter.parameters);
	const outputType = renderSchema(adapter.outputSchema);
	const declaration = `declare const tools: { ${normalizeIdentifier(adapter.name)}(${inputName}: ${inputType}): Promise<${outputType}>; };`;
	return `${adapter.description ?? ""}\n\nexec tool declaration:\n\`\`\`ts\n${declaration}\n\`\`\``;
}

function normalizeIdentifier(name: string): string {
	const normalized = [...name]
		.map((character, index) => {
			const valid =
				index === 0
					? character === "_" || character === "$" || /[A-Za-z]/.test(character)
					: character === "_" || character === "$" || /[A-Za-z0-9]/.test(character);
			return valid ? character : "_";
		})
		.join("");
	return normalized || "_";
}

// type-boundary: Pi adapters expose external JSON Schema values; these renderers validate each shape before traversal.
type UntrustedJsonSchema = unknown;

function renderSchema(schema: UntrustedJsonSchema): string {
	if (schema === true) return "unknown";
	if (schema === false) return "never";
	const value = asRecord(schema);
	if (!value) return "unknown";
	if ("const" in value) return renderLiteral(value.const);
	if (Array.isArray(value.enum) && value.enum.length > 0) return value.enum.map(renderLiteral).join(" | ");
	for (const keyword of ["anyOf", "oneOf"] as const) {
		if (Array.isArray(value[keyword]) && value[keyword].length > 0) return value[keyword].map(renderSchema).join(" | ");
	}
	if (Array.isArray(value.allOf) && value.allOf.length > 0) return value.allOf.map(renderSchema).join(" & ");
	if (Array.isArray(value.type)) {
		const types = value.type.filter((type): type is string => typeof type === "string");
		if (types.length > 0) return types.map((type) => renderSchemaType(value, type)).join(" | ");
	}
	if (typeof value.type === "string") return renderSchemaType(value, value.type);
	if ("properties" in value || "additionalProperties" in value || "required" in value) return renderObjectSchema(value);
	if ("items" in value || "prefixItems" in value) return renderArraySchema(value);
	return "unknown";
}

function renderSchemaType(schema: Record<string, UntrustedJsonSchema>, type: string): string {
	switch (type) {
		case "string":
			return "string";
		case "number":
		case "integer":
			return "number";
		case "boolean":
			return "boolean";
		case "null":
			return "null";
		case "array":
			return renderArraySchema(schema);
		case "object":
			return renderObjectSchema(schema);
		default:
			return "unknown";
	}
}

function renderArraySchema(schema: Record<string, UntrustedJsonSchema>): string {
	if ("items" in schema) return `Array<${renderSchema(schema.items)}>`;
	if (Array.isArray(schema.prefixItems) && schema.prefixItems.length > 0)
		return `[${schema.prefixItems.map(renderSchema).join(", ")}]`;
	return "unknown[]";
}

function renderObjectSchema(schema: Record<string, UntrustedJsonSchema>): string {
	const properties = asRecord(schema.properties) ?? {};
	const required = new Set(
		Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [],
	);
	const sorted = Object.entries(properties).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	if (sorted.some(([, property]) => hasDescription(property))) {
		const lines = ["{"];
		for (const [name, property] of sorted) {
			const description = asRecord(property)?.description;
			if (typeof description === "string") {
				for (const line of description
					.split("\n")
					.map((part) => part.trim())
					.filter(Boolean))
					lines.push(`  // ${line}`);
			}
			lines.push(`  ${renderObjectProperty(name, property, required)}`);
		}
		appendAdditionalProperty(lines, schema, properties, "  ");
		lines.push("}");
		return lines.join("\n");
	}
	const fields = sorted.map(([name, property]) => renderObjectProperty(name, property, required));
	appendAdditionalProperty(fields, schema, properties, "");
	return fields.length === 0 ? "{}" : `{ ${fields.join(" ")} }`;
}

function renderObjectProperty(name: string, property: UntrustedJsonSchema, required: ReadonlySet<string>): string {
	const propertyName = normalizeIdentifier(name) === name ? name : JSON.stringify(name);
	return `${propertyName}${required.has(name) ? "" : "?"}: ${renderSchema(property)};`;
}

function appendAdditionalProperty(
	lines: string[],
	schema: Record<string, UntrustedJsonSchema>,
	properties: Record<string, UntrustedJsonSchema>,
	prefix: string,
): void {
	if ("additionalProperties" in schema) {
		if (schema.additionalProperties === false) return;
		lines.push(
			`${prefix}[key: string]: ${schema.additionalProperties === true ? "unknown" : renderSchema(schema.additionalProperties)};`,
		);
	} else if (Object.keys(properties).length === 0) {
		lines.push(`${prefix}[key: string]: unknown;`);
	}
}

function hasDescription(schema: UntrustedJsonSchema): boolean {
	const description = asRecord(schema)?.description;
	return typeof description === "string" && description.length > 0;
}

function asRecord(value: UntrustedJsonSchema): Record<string, UntrustedJsonSchema> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, UntrustedJsonSchema>)
		: undefined;
}

function renderLiteral(value: UntrustedJsonSchema): string {
	try {
		return JSON.stringify(value) ?? "unknown";
	} catch {
		return "unknown";
	}
}
