// Registry `execute` skips `emitToolCall`/`emitToolResult`, so the block set and the 40,000-char bound are re-applied here.

import { resizeImage } from "@earendil-works/pi-coding-agent";
import { markCaptureTailTruncated } from "../artifact-store/pi/capture.ts";
import { recordNestedExplorationEnd, recordNestedExplorationStart } from "../shared/exploration-rendering.ts";
import { approxTokenCount } from "../shared/output-budget.ts";
import { sessionIdFromContext } from "../shared/session-context.ts";
import { boundTextWithArtifact, resolveToolBudget } from "../shared/tool-bounding.ts";
import { getRegisteredTool, getRegisteredTools, type RegisteredToolDefinition } from "../shared/tool-registry.ts";
import { ToolReach } from "../token-burden/types.ts";
import { deniedToolReason, getToolPolicy, isSessionDeniedTool } from "../tool-policy/policy.ts";
import { type CodeModeToolPreflightRunner, runCodeModeToolPreflight } from "./nested-tool-preflight.ts";
import { unifiedCatalog, unifiedTool } from "./tool-catalog.ts";
import {
	namedOutputDeclaration,
	renderDeclarationBody,
	renderDocComment,
	renderParameterList,
} from "./tool-declarations.ts";
import { hasDeferredTools, TOOL_SEARCH_NAME } from "./tool-search.ts";

// `exec` and `wait` control the cell runner, so dispatching either through that runner would deadlock.
// Agent tools return through the host call now; runtime.ts's `collect` pauses cell time while any host call is outstanding.
const UNNESTABLE_TOOL_REASONS: Record<string, string> = {
	exec: "`exec` is the cell runner and cannot run inside a cell.",
	wait: "`wait` waits on the cell runner and cannot run inside a cell.",
	web_search:
		"`web_search` runs on the provider, not here. Call it directly. To open a page, click a link, find text in a page, search images, or look up weather, finance, sports or time, call `web__run` from a cell.",
};

export const UNNESTABLE_TOOLS = new Set(Object.keys(UNNESTABLE_TOOL_REASONS));

export interface ToolCatalogEntry {
	name: string;
	description: string;
	input: string;
	parameters?: unknown;
}

export interface NestedToolResult {
	text: string;
	details?: unknown;
	artifact?: string;
	images?: NestedImage[];
	raw?: NestedRawResult;
	/** A command's own output, unframed. `text` prefixes 6 lines (`Command:`, `Chunk ID:`, `Wall time:`, exit, token count, `Output:`), so `JSON.parse(r.text)` cannot work. */
	stdout?: string;
}

export interface NestedImage {
	data: string;
	mimeType: string;
}

export interface NestedRawResult {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
}

export interface NestedCallOptions {
	ctx: unknown;
	signal?: AbortSignal;
	maxTokens?: number;
	toolCallId?: string;
	preflight?: CodeModeToolPreflightRunner;
}

function appendRecordedEntry(ctx: unknown, entry: { customType: string; data?: unknown }): void {
	const manager = (
		ctx as { sessionManager?: { appendCustomEntry?: (customType: string, data?: unknown) => unknown } } | undefined
	)?.sessionManager;
	if (typeof manager?.appendCustomEntry !== "function") return;
	try {
		manager.appendCustomEntry(entry.customType, entry.data);
	} catch {
		// Coverage telemetry must not turn a successful edit into a failed tool call.
	}
}

/**
 * The session a nested call belongs to, for the per-session denial check. `ctx` is `unknown` here and is a
 * fabricated object in tests, so an unrecognised shape or a throwing `getSessionId` reads as "no session", which
 * denies nothing.
 */
export function sessionIdOf(ctx: unknown): string | undefined {
	try {
		return sessionIdFromContext(ctx);
	} catch {
		return undefined;
	}
}

export class NestedToolError extends Error {
	readonly name = "NestedToolError";

	constructor(
		message: string,
		readonly toolName: string,
		// Carried so a failed call still reaches its renderer; a non-zero exit from `exec_command` throws here.
		readonly raw?: NestedRawResult,
	) {
		super(message);
	}
}

/** `exec_command` applies its own ceiling; without this the bound re-clipped, so asking for more returned less. */
function argumentBudget(args: unknown): number | undefined {
	const requested = (args as { max_output_tokens?: unknown })?.max_output_tokens;
	return typeof requested === "number" && Number.isFinite(requested) ? requested : undefined;
}

/** A circular reference in `details` would throw inside the reply and strand the cell; the round trip happens here. */
function serialisableDetails(details: unknown): unknown {
	if (details === undefined || details === null) return undefined;
	try {
		return JSON.parse(JSON.stringify(details));
	} catch {
		return undefined;
	}
}

const RAW_DETAILS_MAX_TOKENS = 50_000;

function boundedRawResult(result: unknown, text: string): NestedRawResult {
	const raw = result && typeof result === "object" ? (result as NestedRawResult) : { content: [] };
	const content = (raw as { content?: unknown }).content;
	const nonText = Array.isArray(content)
		? content.filter(
				(item): item is { type: string; text?: string } =>
					!!item &&
					typeof item === "object" &&
					"type" in item &&
					typeof item.type === "string" &&
					item.type !== "text",
			)
		: [];
	return {
		...raw,
		content: [{ type: "text", text }, ...nonText],
		details: boundDetails(serialisableDetails(raw.details), RAW_DETAILS_MAX_TOKENS),
	};
}

/** `exec_command` puts its whole output in `details.output` as well as its text, so printing the result paid twice. */
const DETAILS_BUDGET_SHARE = 0.5;

function boundDetails(details: unknown, budgetTokens: number): unknown {
	if (details === undefined) return undefined;
	const serialised = JSON.stringify(details);
	if (serialised === undefined) return undefined;
	const tokens = approxTokenCount(serialised);
	const ceiling = Math.max(1, Math.floor(budgetTokens * DETAILS_BUDGET_SHARE));
	if (tokens <= ceiling) return details;
	return {
		omitted: `details was ~${tokens} tokens, over the ~${ceiling} allowed beside the text. The text above is the tool's own rendering of the same result.`,
	};
}

/** The shape a renderer and `execute` both see, so a row cannot describe arguments the tool never ran. */
export function normalizeToolArgs(name: string, args: unknown): unknown {
	const definition = getRegisteredTool(name);
	return definition ? normalizeArgs(definition, args) : (args ?? {});
}

/** Codex accepts `tools.edit(patch)`, and these schemas want `{ input }`. */
function normalizeArgs(definition: RegisteredToolDefinition, args: unknown): unknown {
	if (typeof args !== "string") return args ?? {};
	const schema = definition.parameters as { required?: unknown; properties?: Record<string, unknown> } | undefined;
	const required = Array.isArray(schema?.required) ? schema.required : [];
	const key = required.length === 1 && typeof required[0] === "string" ? required[0] : undefined;
	return key && schema?.properties?.[key] ? { [key]: args } : args;
}

function megabytes(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// `textOf` keeps only text, so a nested `view_image` reached the model with no pixels.
// Removed rather than copied: render.ts:521 draws them, and the tool's own renderResult at render.ts:372 would draw them again.
// `resizeImage` applies pi's own 2000x2000 / 4.5 MB ceiling, which an MCP server's image has no producer to apply.
async function takeBoundedImages(result: unknown): Promise<NestedImage[]> {
	const content = (result as { content?: unknown })?.content;
	if (!Array.isArray(content)) return [];
	const found: NestedImage[] = [];
	for (let index = content.length - 1; index >= 0; index--) {
		const item = content[index];
		if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "image") continue;
		const { data, mimeType } = item as { data?: unknown; mimeType?: unknown };
		if (typeof data !== "string" || typeof mimeType !== "string") continue;
		found.unshift({ data, mimeType });
		content.splice(index, 1);
	}
	const bounded: NestedImage[] = [];
	for (const image of found) {
		const bytes = Buffer.from(image.data, "base64");
		const fitted = await resizeImage(bytes, image.mimeType).catch(() => null);
		if (fitted) {
			bounded.push({ data: fitted.data, mimeType: fitted.mimeType });
			continue;
		}
		content.push({
			type: "text",
			text: `[Image omitted: ${megabytes(bytes.byteLength)} of ${image.mimeType} would not fit pi's 2000x2000, 4.5 MB inline limit.]`,
		});
	}
	return bounded;
}

function textOf(result: unknown): string {
	const content = (result as { content?: unknown })?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(item): item is { text: string } =>
				!!item && typeof item === "object" && (item as { type?: unknown }).type === "text",
		)
		.map((item) => item.text)
		.join("\n");
}

interface ProcessArtifactState {
	uri?: string;
}

const processArtifacts = new Map<string, ProcessArtifactState>();

function processArtifactKey(name: string, params: unknown, ctx: unknown): string | undefined {
	if (name !== "write_stdin" || !params || typeof params !== "object") return undefined;
	const processId = (params as { process_id?: unknown }).process_id;
	if (typeof processId !== "number" && typeof processId !== "string") return undefined;
	return `${sessionIdOf(ctx) ?? "default"}:write_stdin:${processId}`;
}

function processCapture(
	name: string,
	params: unknown,
	details: unknown,
	ctx: unknown,
):
	| {
			state: ProcessArtifactState;
			text: string;
			terminal: boolean;
	  }
	| undefined {
	if (!details || typeof details !== "object") return undefined;
	const record = details as {
		capture_output?: unknown;
		capture_output_truncated?: unknown;
		terminal_state?: unknown;
	};
	const capture = record.capture_output;
	const key = processArtifactKey(name, params, ctx);
	if (!key || typeof capture !== "string") return undefined;
	let state = processArtifacts.get(key);
	if (!state) {
		state = {};
		processArtifacts.set(key, state);
	}
	return {
		state,
		text: record.capture_output_truncated === true ? markCaptureTailTruncated(capture) : capture,
		terminal: typeof record.terminal_state === "string",
	};
}

function editDistance(left: string, right: string): number {
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
		const current = [leftIndex];
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
			current[rightIndex] = Math.min(
				current[rightIndex - 1] + 1,
				previous[rightIndex] + 1,
				previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
			);
		}
		previous = current;
	}
	return previous[right.length];
}

function nearestToolName(name: string, cwd: string, sessionId?: string): string | undefined {
	let nearest: string | undefined;
	let distance = Number.POSITIVE_INFINITY;
	for (const candidate of new Set([
		...getRegisteredTools(sessionId).keys(),
		...unifiedCatalog(sessionId, cwd).map((entry) => entry.name),
	])) {
		const candidateDistance = editDistance(name, candidate);
		if (candidateDistance < distance || (candidateDistance === distance && candidate < (nearest ?? candidate))) {
			nearest = candidate;
			distance = candidateDistance;
		}
	}
	return nearest && distance <= Math.ceil(Math.max(name.length, nearest.length) * 0.4) ? nearest : undefined;
}

export async function callNestedTool(
	name: string,
	args: unknown,
	options: NestedCallOptions,
): Promise<NestedToolResult> {
	const unnestable = UNNESTABLE_TOOL_REASONS[name];
	if (unnestable) throw new NestedToolError(unnestable, name);

	const sessionId = sessionIdOf(options.ctx);
	if (isSessionDeniedTool(sessionId, name)) throw new NestedToolError(deniedToolReason(name), name);

	const policy = getToolPolicy(sessionId);
	if (policy?.isHidden(name)) {
		throw new NestedToolError(`\`${name}\` is blocked by tool policy and stays blocked inside a cell.`, name);
	}

	const cwdValue = (options.ctx as { cwd?: unknown } | undefined)?.cwd;
	const cwd = typeof cwdValue === "string" ? cwdValue : process.cwd();
	const catalogEntry = unifiedTool(name, cwd, sessionId);
	const definition = getRegisteredTool(name, sessionId) ?? catalogEntry?.definition;
	if (!definition) {
		const nearest = nearestToolName(name, cwd, sessionId);
		const hint = nearest
			? `Did you mean \`${nearest}\`?`
			: /artifact/i.test(name)
				? 'Read an artifact with `tools.read({path: "artifact://<id>"})`; `search` and `find` take the same URI.'
				: `Call \`tools.${TOOL_SEARCH_NAME}({ query: ${JSON.stringify(name)} })\` to find the one you want.`;
		throw new NestedToolError(`No tool named \`${name}\`. ${hint}`, name);
	}

	const toolCallId = options.toolCallId ?? `cell-${name}-${Math.random().toString(36).slice(2, 10)}`;
	const execute = definition.execute as (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<unknown>;
	// The agent loop runs this before schema validation (agent-loop.js:380); a cell reached `execute` directly, so
	// every compatibility alias was dead here. `search({query})` returned "No matches found" for a file it never
	// searched — 19 of 1143 nested search calls. Same shim, same place in the sequence, so a nested call and a
	// direct call now normalise identically.
	// `normalizeArgs` first, so a positional `tools.read("a.ts:1-10")` is an object by the time the shim sees it.
	const normalized = normalizeArgs(definition, args);
	const params = definition.prepareArguments ? definition.prepareArguments(normalized) : normalized;
	const signal = options.signal ?? new AbortController().signal;
	await runCodeModeToolPreflight(
		name,
		params,
		{
			cwd,
			toolCallId,
			extensionContext: options.ctx as never,
			preflight: options.preflight,
		},
		signal,
	);
	// pi emits these two around a call it dispatched. Without them a tool's renderers both drew a row.
	recordNestedExplorationStart(name, toolCallId, params);
	let result: unknown;
	try {
		result = await execute(toolCallId, params, signal, undefined, options.ctx);
	} finally {
		recordNestedExplorationEnd(name, toolCallId);
	}

	const images = await takeBoundedImages(result);
	const text = textOf(result);
	const budget = resolveToolBudget(name, options.maxTokens ?? argumentBudget(args));
	const details = (result as { details?: unknown })?.details;
	const capture = processCapture(name, params, details, options.ctx);
	const bounded = await boundTextWithArtifact(text, {
		maxTokens: budget,
		label: `${name} (nested)`,
		artifactUri: capture?.state.uri,
		artifactText: capture?.text,
		ownerSessionId: sessionIdFromContext(options.ctx),
	});
	if (capture) {
		capture.state.uri = bounded.artifactUri ?? capture.state.uri;
		if (capture.terminal) processArtifacts.delete(processArtifactKey(name, params, options.ctx)!);
	}
	try {
		const entry = definition.nestedResult?.recordEntry?.({ details, text, args: params });
		if (entry) appendRecordedEntry(options.ctx, entry);
	} catch {
		// Coverage telemetry must not turn a successful edit into a failed tool call.
	}

	const raw = boundedRawResult(result, bounded.text);
	if ((result as { isError?: unknown })?.isError === true) {
		throw new NestedToolError(bounded.text || `\`${name}\` failed.`, name, raw);
	}
	const projected = definition.nestedResult?.projectDetails
		? definition.nestedResult.projectDetails({ details, text, args: params })
		: details;
	let projectedDetails = serialisableDetails(projected);
	if (
		projectedDetails &&
		typeof projectedDetails === "object" &&
		!Array.isArray(projectedDetails) &&
		"outputTokens" in projectedDetails
	) {
		const record = projectedDetails as Record<string, unknown>;
		projectedDetails = {
			...record,
			outputTokens: approxTokenCount(bounded.text),
			outputBounded: bounded.truncated || record.outputBounded === true,
		};
	}
	return {
		text: bounded.text,
		details: boundDetails(projectedDetails, budget),
		artifact: bounded.artifactUri,
		images: images.length > 0 ? images : undefined,
		raw,
		stdout: commandStdout(details),
	};
}

// The first live turn on the flipped surface burned a cell on `ALL_TOOLS.filter(...)` before it could run `ls`.
// Named `stdout` because that is what the model already reaches for: measured 3 of 232 cells guessed `r.stdout` or
// `r.output` on `exec_command`, one committing `text(r.stdout)` and printing undefined. It was reaching for the raw
// output because `text` does not offer any. Sourced from the tool's own `output`, so no command is re-run.
function commandStdout(details: unknown): string | undefined {
	if (!details || typeof details !== "object") return undefined;
	const output = (details as { output?: unknown }).output;
	return typeof output === "string" ? output : undefined;
}
/** Build one declaration block from programmatic, MCP/App, and TOML entries. */
export function buildCoreToolDeclarations(
	allowed?: readonly string[],
	sessionId?: string,
	cwd = process.cwd(),
): string | undefined {
	const scope = allowed && allowed.length > 0 ? new Set(allowed.map((name) => name.toLowerCase())) : undefined;
	const members: string[] = [];
	const resultDeclarations = new Map<string, string>();
	for (const entry of unifiedCatalog(sessionId, cwd)) {
		const { name, definition, reach } = entry;
		if (!definition || reach !== ToolReach.Declared) continue;
		if (scope && !scope.has(name.toLowerCase())) continue;
		const output = namedOutputDeclaration(definition.nestedResult?.details);
		if (output) {
			const previous = resultDeclarations.get(output.name);
			if (previous && previous !== output.declaration)
				throw new Error(`Conflicting output schemas named ${output.name}.`);
			resultDeclarations.set(output.name, output.declaration);
		}
		const description = renderDeclarationBody(definition);
		if (description) members.push(renderDocComment(description, "\t"));
		members.push(
			`\t${name}(${renderParameterList(definition.parameters, "\t")}): Promise<${output ? `ToolResult<${output.name}>` : "CallResult"}>;`,
		);
	}
	if (members.length === 0) return undefined;
	const types = [...resultDeclarations].map(([name, declaration]) => `type ${name} = ${declaration};`);
	const resultTypes =
		types.length > 0
			? [
					"type OmittedDetails = { omitted: string };",
					"type ToolResult<T> = { text: string; stdout?: string; details?: T | OmittedDetails; artifact?: string };",
					...types,
				]
			: [];
	return [
		"Core tools, already declared — call these directly, no lookup needed:",
		"",
		"```ts",
		"type CallResult = { text: string; stdout?: string; details?: unknown; artifact?: string };",
		...(resultTypes.length > 0 ? [...resultTypes, ""] : [""]),
		"declare const tools: {",
		...members,
		"};",
		"```",
		"",
		hasDeferredTools(sessionId, cwd)
			? "Some tools are omitted here. They are still on `tools`: use `tool_search` to find one."
			: "Some tools are omitted here. They are still on `tools`.",
	].join("\n");
}

/** `sessionId` drops that session's denied tools. Models copy what the catalog hands them, so a denied tool has to
 * be absent here as well as refused by `callNestedTool`. */
export function buildToolCatalog(sessionId?: string, cwd = process.cwd()): ToolCatalogEntry[] {
	const entries: ToolCatalogEntry[] = [];
	for (const entry of unifiedCatalog(sessionId, cwd)) {
		if (UNNESTABLE_TOOLS.has(entry.name)) continue;
		const catalogEntry: ToolCatalogEntry = {
			name: entry.name,
			description: entry.description,
			input: entry.input,
			parameters: entry.parameters,
		};
		Object.defineProperty(catalogEntry, "toJSON", {
			configurable: true,
			enumerable: true,
			value: () => catalogEntry.name,
		});
		entries.push(catalogEntry);
	}
	return entries.sort((left, right) => left.name.localeCompare(right.name));
}
