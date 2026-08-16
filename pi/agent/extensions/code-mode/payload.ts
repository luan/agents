/**
 * Grammar frames raw cell source. `SOURCE` accepts malformed JavaScript; the Rust host strips TypeScript
 * best-effort before running the source (`rust-kernel.ts:29` `rustSource()`), and a cell whose source it could
 * not strip fails inside V8 with a plain JS syntax error, not a TypeScript-aware one.
 *
 * `SOURCE` stays permissive on purpose. A full TypeScript grammar here would duplicate that stripping pass.
 */

import type { CellLanguage } from "./runtime.ts";

export const EXEC_GRAMMAR = String.raw`start: pragma_source | plain_source
pragma_source: PRAGMA_LINE NEWLINE SOURCE
plain_source: SOURCE

PRAGMA_LINE: /[ \t]*\/\/ @exec:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/
`;

// Sits beside the grammar because codex-native/index.ts:93 ships the pair together: a custom tool carries its own
// description, and a description that disagreed with the registered tool's would describe a call the model cannot make.
export const EXEC_DESCRIPTION = `Run TypeScript code to orchestrate/compose tool calls
- Evaluates the provided TypeScript code in a fresh V8 isolate as an async module.
- All nested tools are available on the global \`tools\` object, for example \`await tools.exec_command(...)\`. Tool names are exposed as normalized TypeScript identifiers, for example \`await tools.mcp__ologs__get_profile(...)\`.
- Nested tool methods take either a string or an object as their input argument.
- Nested tools return either an object or a string, based on the description.
- Runs raw TypeScript -- no Node, no file system, no network access, no console.
- Accepts raw TypeScript source text, not JSON, quoted strings, or markdown code fences.
- You may optionally start the tool input with a first-line pragma like \`// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}\`.
- \`yield_time_ms\` asks \`exec\` to yield early if the script is still running. Defaults to 30000 ms.
- \`max_output_tokens\` sets the token budget for direct \`exec\` results. Defaults to 10000 tokens.
- When the code is fully evaluated, the isolate's lifetime ends and unawaited promises are silently discarded.

- Global helpers:
- \`exit()\`: Immediately ends the current script successfully (like an early return from the top level).
- \`text(value: string | number | boolean | undefined | null)\`: Appends a text item. Non-string values are stringified with \`JSON.stringify(...)\` when possible.
- \`image(imageUrlOrItem: string | { image_url: string; detail?: "auto" | "low" | "high" | "original" | null } | ImageContent, detail?: "auto" | "low" | "high" | "original" | null)\`: Appends an image item. \`image_url\` should be a base64-encoded \`data:\` URL. To forward an MCP tool image, pass an individual \`ImageContent\` block from \`result.content\`, for example \`image(result.content[0])\`. MCP image blocks may request detail with \`_meta: { "codex/imageDetail": "original" }\`. When provided, the second \`detail\` argument overrides any detail embedded in the first argument.
- \`audio(audioUrlOrItem: string | { audio_url: string } | AudioContent)\`: Appends an audio item. \`audio_url\` should be a base64-encoded \`data:\` URL. To forward an MCP tool audio block, pass an individual \`AudioContent\` block from \`result.content\`, for example \`audio(result.content[0])\`.
- \`generatedImage(result: { image_url: string; output_hint?: string })\`: Appends an image-generation result and its optional output hint. HTTP(S) URLs are not supported.
- \`store(key: string, value: any)\`: stores a serializable value under a string key for later \`exec\` calls in the same session.
- \`load(key: string)\`: returns the stored value for a string key, or \`undefined\` if it is missing.
- \`notify(value: string | number | boolean | undefined | null)\`: immediately injects an extra \`custom_tool_call_output\` for the current \`exec\` call. Values are stringified like \`text(...)\`.
- \`setTimeout(callback: () => void, delayMs?: number)\`: schedules a callback to run later and returns a timeout id. Pending timeouts do not keep \`exec\` alive by themselves; await an explicit promise if you need to wait for one.
- \`clearTimeout(timeoutId?: number)\`: cancels a timeout created by \`setTimeout\`.
- \`ALL_TOOLS\`: metadata for the enabled nested tools as \`{ name, description }\` entries.
- \`yield_control()\`: yields the accumulated output to the model immediately while the script keeps running.

- Raw block for source containing backticks or backslashes: open a line ending with an at-sign and backtick, close with a line starting with a backtick and at-sign. The block becomes one string:
\`\`\`
const r = await tools.edit(@\`
<patch>
\`@);
\`\`\`
- \`await tools.tool_search({ query })\` returns the declarations of tools left out of the system prompt, best match first.
- Oversized nested results are cut and spilled to \`r.artifact\`, read back with \`await tools.read(r.artifact)\`.
- A cell still running when \`yield_time_ms\` elapses returns a \`cell_id\` for \`wait\`.`;

export function preprocessRawBlockLiterals(source: string): string {
	const newline = source.includes("\r\n") ? "\r\n" : "\n";
	const lines = source.split(/\r?\n/);
	for (let opening = 0; opening < lines.length; opening += 1) {
		const open = lines[opening]?.match(/^(.*)@`[ \t]*$/);
		if (!open) continue;
		let closing = opening + 1;
		while (closing < lines.length && !/^[ \t]*`@/.test(lines[closing] ?? "")) closing += 1;
		if (closing === lines.length) {
			throw new SyntaxError(`Raw block literal at line ${opening + 1} has no closing \`@ line.`);
		}
		const close = lines[closing]?.match(/^[ \t]*`@(.*)$/);
		const bodyLines = lines.slice(opening + 1, closing);
		const body = bodyLines.length > 0 ? `${bodyLines.join(newline)}${newline}` : "";
		lines[opening] = `${open[1]}${JSON.stringify(body)}`;
		for (let line = opening + 1; line < closing; line += 1) lines[line] = "";
		lines[closing] = close?.[1] ?? "";
		opening = closing;
	}
	return lines.join(newline);
}

const PRAGMA = /^[ \t]*\/\/ @exec:([^\r\n]*)(?:\r?\n)?/;

export interface CellOptions {
	language?: CellLanguage;
	yield_time_ms?: number;
	max_output_tokens?: number;
}

export interface CellParams extends CellOptions {
	code: string;
}

function asLanguage(value: unknown): CellLanguage | undefined {
	return value === "ts" || value === "js" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	const parsed = typeof value === "string" ? Number(value) : value;
	return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}

function readOptions(source: Record<string, unknown>): CellOptions {
	const options: CellOptions = {};
	const language = asLanguage(source.language);
	const yieldTimeMs = asNumber(source.yield_time_ms);
	const maxOutputTokens = asNumber(source.max_output_tokens);
	if (language) options.language = language;
	if (yieldTimeMs !== undefined) options.yield_time_ms = yieldTimeMs;
	if (maxOutputTokens !== undefined) options.max_output_tokens = maxOutputTokens;
	return options;
}

/** The pragma is hand-written JSON. The line is removed before the selected runtime parses the cell. */
export function splitCellPayload(code: string): CellParams {
	const match = PRAGMA.exec(code);
	if (!match) return { code };
	let parsed: unknown;
	try {
		parsed = JSON.parse(match[1].trim());
	} catch {
		parsed = undefined;
	}
	const options =
		parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	return { code: code.slice(match[0].length), ...readOptions(options) };
}

export function prepareCellArguments(args: unknown): CellParams {
	const record: Record<string, unknown> =
		typeof args === "string" ? { code: args } : args && typeof args === "object" ? { ...args } : {};
	const code = typeof record.code === "string" ? record.code : "";
	return { ...readOptions(record), ...splitCellPayload(code) };
}

// `exec({cmd: "grep -RIn Error crates"})` reached `readOptions`, which keeps only known keys, so the call arrived as
// `{code: ""}` — schema-valid, an empty program, and a successful result. The model then reported "It printed 0 lines".
// 12 of 13 wrong shapes did this: `command`, `script`, `source`, `input`, `program`, `body`, `{}`, and a non-string `code`.
const EXEC_NOTHING_TO_RUN =
	'exec ran nothing: `code` was absent, empty, or not a string. `code` is exec\'s only required parameter and holds the raw cell body, TypeScript by default — not a shell command. To run a shell command, put it in the cell: `const r = await tools.exec_command({ cmd: "ls -la" }); text(r.text);`';

export function nothingToRunReason(params: CellParams): string | undefined {
	return params.code.trim().length > 0 ? undefined : EXEC_NOTHING_TO_RUN;
}
