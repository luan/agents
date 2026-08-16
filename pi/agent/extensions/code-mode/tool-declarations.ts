// A TypeBox schema is JSON Schema at runtime, so this renders it structurally and falls back to `unknown`.

const MAX_DEPTH = 4;

type Schema = Record<string, unknown>;

function isSchema(value: unknown): value is Schema {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function literal(value: unknown): string {
	return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function propertyKey(name: string): string {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function unionOf(members: string[]): string {
	const unique = [...new Set(members)].filter((member) => member !== "unknown");
	if (unique.length === 0) return "unknown";
	return unique.join(" | ");
}

function renderType(schema: unknown, depth: number, indent: string, flat = false): string {
	if (!isSchema(schema)) return "unknown";
	if (depth > MAX_DEPTH) return "unknown";

	if (Array.isArray(schema.enum)) return unionOf(schema.enum.map(literal));
	if ("const" in schema) return literal(schema.const);

	// TypeBox emits unions as `anyOf`; a JSON Schema written by hand may use `oneOf`.
	const variants = schema.anyOf ?? schema.oneOf;
	if (Array.isArray(variants)) {
		return unionOf(variants.map((variant) => renderType(variant, depth + 1, indent, flat)));
	}

	switch (schema.type) {
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
			return `${renderType(schema.items, depth + 1, indent, flat)}[]`;
		case "object":
			return flat ? "object" : renderObject(schema, depth, indent);
		default:
			if (!isSchema(schema.properties)) return "unknown";
			return flat ? "object" : renderObject(schema, depth, indent);
	}
}

/**
 * `Type.Array(Type.String({description}))` annotates the item, not the array, and `renderType` collapses the
 * array to `string[]` — so the text was dropped. `find`'s `paths` reached this surface as a bare
 * `paths?: string[];` and models used it in 14 of 374 nested calls (3.7%), reaching for the documented
 * `path`+`pattern` pair instead; on the JSON-schema surface, where the item description survives, `paths` won
 * 763 of 963 calls (79.2%). Same divergence, same undocumented property.
 */
function propertyDescription(property: unknown): string {
	if (!isSchema(property)) return "";
	if (typeof property.description === "string" && property.description.trim()) return property.description;
	const items = property.type === "array" ? property.items : undefined;
	return isSchema(items) && typeof items.description === "string" ? items.description : "";
}

function renderObject(schema: Schema, depth: number, indent: string): string {
	const properties = isSchema(schema.properties) ? schema.properties : undefined;
	if (!properties) return "Record<string, unknown>";
	const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
	const inner = `${indent}\t`;
	const lines: string[] = [];
	for (const [name, property] of Object.entries(properties)) {
		const description = propertyDescription(property);
		// Unescaped, a `*/` in a property description closes the comment and spills the rest of the sentence into the
		// declaration as code — `renderDocComment` already guarded its own text, this path never did.
		if (description) lines.push(`${inner}/** ${commentSafe(description.replace(/\s+/g, " ").trim())} */`);
		lines.push(
			`${inner}${propertyKey(name)}${required.has(name) ? "" : "?"}: ${renderType(property, depth + 1, inner)};`,
		);
	}
	if (lines.length === 0) return "Record<string, unknown>";
	return `{\n${lines.join("\n")}\n${indent}}`;
}

export interface NamedDeclaration {
	name: string;
	declaration: string;
}

export function namedOutputDeclaration(schema: unknown, indent = ""): NamedDeclaration | undefined {
	if (!isSchema(schema) || typeof schema.title !== "string" || !schema.title.trim()) return undefined;
	return { name: schema.title.trim(), declaration: renderType(schema, 0, indent) };
}

/** `edit`'s existing member name, so a schema carrying no `title` still reads as a value rather than a bag. */
const DEFAULT_VALUE_PARAMETER = "input";

/**
 * The whole parameter list, so a single-value tool declares `read(path: string)` instead of `read(args: {path: string})`.
 * A schema with no `properties` used to fall through to `Record<string, unknown>` — neither a string nor an error.
 *
 * The name comes from the schema's own `title`, which is where TypeBox passes a JSON Schema annotation through, and
 * falls back to `input`. `normalizeArgs` (nested-dispatch.ts:109) already leaves a bare string intact when a schema has
 * no `properties`, so a cell writing `tools.read("a.ts:1-10")` reaches the tool unwrapped.
 */
export function renderParameterList(parameters: unknown, indent = ""): string {
	const single = singleRequiredProperty(parameters);
	if (single) {
		const rendered = `${single.name}: ${renderType(single.schema, 0, indent)}`;
		const description = collapsedDescription(single.schema);
		if (!description) return rendered;
		// The collapse skips `renderObject`, the only place a property description is emitted, so `read`'s selector
		// grammar (fileops/index.ts:529-533) reached the model as the bare word "selector" and it invented `#L45-L75`.
		const inner = `${indent}\t`;
		return `\n${renderDocComment(description, inner)}\n${inner}${rendered},\n${indent}`;
	}
	const rendered = renderType(parameters, 0, indent);
	if (rendered.startsWith("{") || rendered === "object" || rendered === "Record<string, unknown>") {
		return `args: ${rendered}`;
	}
	const title = isSchema(parameters) && typeof parameters.title === "string" ? parameters.title.trim() : "";
	return `${title || DEFAULT_VALUE_PARAMETER}: ${rendered}`;
}

/**
 * A single-member object declares as its member, so `read(path: string)` rather than `read(args: {path: string})`.
 * The member's own key names it, so no schema needs a `title`. Today this is `read` and `edit` and nothing else; a tool
 * with a second property keeps `args`.
 *
 * This makes the wrong shape *unsuggested, not impossible*: a cell can still write `tools.read({path, offset})` and the
 * object reaches the tool untouched, where `read`'s range refusal catches it. What changes is that the declaration no
 * longer shows an args object, so nothing prompts adding keys. The wire schema is unchanged — `normalizeArgs`
 * (nested-dispatch.ts:109) already wraps a bare string for exactly this shape, so no provider sees a non-object schema.
 */
function collapsedDescription(schema: unknown): string {
	return isSchema(schema) && typeof schema.description === "string" ? schema.description.trim() : "";
}

function singleRequiredProperty(parameters: unknown): { name: string; schema: unknown } | undefined {
	if (!isSchema(parameters) || parameters.type !== "object") return undefined;
	const properties = isSchema(parameters.properties) ? parameters.properties : undefined;
	if (!properties) return undefined;
	const entries = Object.entries(properties);
	const required = Array.isArray(parameters.required) ? parameters.required.map(String) : [];
	if (entries.length !== 1 || required.length !== 1) return undefined;
	const [name, schema] = entries[0] as [string, unknown];
	return required[0] === name ? { name, schema } : undefined;
}

// Declared means the JSON schema is omitted, never the description. A one-line summary cost `edit` its input format
// (0.0% first-try patch success across 220 trials), `search` its routing argument, and `read` its summary footer.
/** A Declared tool's description, verbatim. */
export function renderDeclarationBody(definition: { description?: unknown }): string {
	return typeof definition.description === "string" ? definition.description.trim() : "";
}

// A comment-closing sequence inside a description would end the comment early and spill the rest of the sentence
// into the declaration as code. The rewrite below is lossy — a recursive glob gains a space and stops being a valid
// glob — so a description written to be copied must avoid the sequence outright rather than lean on this.
function commentSafe(text: string): string {
	return text.replaceAll("*/", "* /");
}

/** The description as a doc comment above its signature, which is how codex renders a nested tool (description.rs:260). */
export function renderDocComment(text: string, indent: string): string {
	const body = commentSafe(text).split("\n");
	return [`${indent}/**`, ...body.map((line) => `${indent} *${line ? ` ${line}` : ""}`), `${indent} */`].join("\n");
}
