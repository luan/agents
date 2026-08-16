/**
 * One-shot Deno diagnostics for a notebook journal.
 *
 * The journal is a standard `.ipynb`. Its owner reads the code cells and passes them in, so this
 * module never touches the journal files. Cells open as one `notebookDocument`, which is what makes
 * a name defined in cell 1 visible in cell 2.
 *
 * The LSP does not know the injected runtime, so bindings the bootstrap installs and bindings a
 * profile or the project state restored would each report as `Cannot find name`. Those are filtered
 * out, not reported.
 */

import { pathToFileURL } from "node:url";
import { OneShotLspProcess } from "./lsp-process.ts";

const DIAGNOSTIC_TIMEOUT_MS = 30_000;
const MESSAGE_BUDGET = 16 * 1024;

/** Installed by the kernel bootstrap, so the LSP never sees them declared. */
const HOST_BINDINGS = new Set([
	"ALL_TOOLS",
	"exit",
	"generatedImage",
	"image",
	"load",
	"notify",
	"store",
	"text",
	"tools",
	"yield_control",
]);

export interface NotebookCodeCell {
	id: string;
	index: number;
	source: string;
}

export interface NotebookDiagnostic {
	cellId: string;
	cellIndex: number;
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	severity: "error" | "warning" | "information" | "hint" | "unknown";
	code?: string | number | undefined;
	source?: string | undefined;
	message: string;
}

export interface NotebookDiagnosticsResult {
	message: string;
	details: Record<string, unknown>;
}

export async function diagnoseNotebook(options: {
	deno: string;
	cwd: string;
	path: string;
	cells: NotebookCodeCell[];
	runtimeBindings?: ReadonlySet<string> | undefined;
	signal?: AbortSignal | undefined;
}): Promise<NotebookDiagnosticsResult> {
	if (options.cells.length === 0) {
		return {
			message: `No code cells to diagnose in ${options.path}`,
			details: { path: options.path, cells: 0, diagnostics: [] },
		};
	}

	const timeout = AbortSignal.timeout(DIAGNOSTIC_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	signal.throwIfAborted();
	const lsp = new OneShotLspProcess({ deno: options.deno, cwd: options.cwd, signal });
	try {
		const rootUri = directoryUri(options.cwd);
		await lsp.request("initialize", {
			processId: process.pid,
			clientInfo: { name: "pi-notebook-diagnostics" },
			rootUri,
			workspaceFolders: [{ uri: rootUri, name: options.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "workspace" }],
			capabilities: {
				workspace: { configuration: false, workspaceFolders: false },
				textDocument: { diagnostic: {}, publishDiagnostics: { relatedInformation: true } },
				notebookDocument: { synchronization: { dynamicRegistration: false, executionSummarySupport: false } },
			},
			initializationOptions: { enable: true },
		});
		lsp.notify("initialized", {});

		const notebookUri = pathToFileURL(options.path).href;
		const documents = options.cells.map((cell) => ({
			cell,
			uri: notebookCellUri(options.path, cell.index, cell.id),
		}));
		lsp.notify("notebookDocument/didOpen", {
			notebookDocument: {
				uri: notebookUri,
				notebookType: "jupyter-notebook",
				version: 1,
				// kind 2 is LSP NotebookCellKind.Code.
				cells: documents.map(({ uri }) => ({ kind: 2, document: uri })),
			},
			cellTextDocuments: documents.map(({ cell, uri }) => ({
				uri,
				languageId: "typescript",
				version: 1,
				text: cell.source,
			})),
		});
		const reports: unknown[] = [];
		for (const { uri } of documents) {
			reports.push(await lsp.request("textDocument/diagnostic", { textDocument: { uri } }));
		}
		const runtimeBindings = new Set([...HOST_BINDINGS, ...(options.runtimeBindings ?? [])]);
		const diagnostics = reports.flatMap((report, index) =>
			parseDiagnosticReport(report, documents[index]!.cell, runtimeBindings),
		);
		lsp.notify("notebookDocument/didClose", {
			notebookDocument: { uri: notebookUri },
			cellTextDocuments: documents.map(({ uri }) => ({ uri })),
		});
		return formatDiagnostics(options.path, options.cells.length, diagnostics);
	} finally {
		await lsp.shutdown();
	}
}

export function parseDiagnosticReport(
	value: unknown,
	cell: NotebookCodeCell,
	runtimeBindings: ReadonlySet<string>,
): NotebookDiagnostic[] {
	if (!isRecord(value) || !Array.isArray(value["items"])) return [];
	return value["items"].flatMap((item) => {
		if (!isRecord(item) || typeof item["message"] !== "string" || !isRange(item["range"])) return [];
		const range = item["range"];
		if (isRuntimeDiagnostic(item, range, cell.source, runtimeBindings)) return [];
		return [
			{
				cellId: cell.id,
				cellIndex: cell.index,
				line: range.start.line + 1,
				column: range.start.character + 1,
				endLine: range.end.line + 1,
				endColumn: range.end.character + 1,
				severity: severityName(item["severity"]),
				...(typeof item["code"] === "string" || typeof item["code"] === "number" ? { code: item["code"] } : {}),
				...(typeof item["source"] === "string" ? { source: item["source"] } : {}),
				message: item["message"],
			},
		];
	});
}

/**
 * TS 2304 is `Cannot find name 'x'`; drop it when the runtime supplies `x`.
 * TS 7017 is an implicit-any index; drop it only for `globalThis.<name>`, which the runtime allows.
 */
function isRuntimeDiagnostic(
	diagnostic: Record<string, unknown>,
	range: { start: { line: number; character: number }; end: { line: number; character: number } },
	source: string,
	runtimeBindings: ReadonlySet<string>,
): boolean {
	if (diagnostic["code"] === 2304 && typeof diagnostic["message"] === "string") {
		const name = /^Cannot find name '([^']+)'/.exec(diagnostic["message"])?.[1];
		if (name && runtimeBindings.has(name)) return true;
	}
	if (diagnostic["code"] !== 7017) return false;
	const line = source.split("\n")[range.start.line];
	return line !== undefined && /globalThis\s*\.\s*$/.test(line.slice(0, range.start.character));
}

export function formatDiagnostics(
	path: string,
	cells: number,
	diagnostics: NotebookDiagnostic[],
): NotebookDiagnosticsResult {
	if (diagnostics.length === 0) {
		return {
			message: `No Deno diagnostics in ${path} (${cells} code cells)`,
			details: { path, cells, diagnostics: [] },
		};
	}
	const lines = [`Deno diagnostics for ${path}:`];
	const included: NotebookDiagnostic[] = [];
	for (const diagnostic of diagnostics) {
		const code = diagnostic.code === undefined ? "" : ` ${diagnostic.source ?? "deno"}-${diagnostic.code}`;
		const line = `- ${diagnostic.cellId} cell ${diagnostic.cellIndex + 1}:${diagnostic.line}:${diagnostic.column} ${diagnostic.severity}${code}: ${diagnostic.message.replaceAll("\n", " ")}`;
		if (lines.join("\n").length + line.length + 1 > MESSAGE_BUDGET) break;
		lines.push(line);
		included.push(diagnostic);
	}
	const omitted = diagnostics.length - included.length;
	if (omitted > 0) {
		lines.push(
			`${omitted} additional diagnostic${omitted === 1 ? "" : "s"} omitted; repair these and run diagnostics again`,
		);
	}
	return { message: lines.join("\n"), details: { path, cells, diagnostics: included, omitted } };
}

function notebookCellUri(path: string, index: number, id: string): string {
	return `deno-notebook-cell:${pathToFileURL(path).pathname}#${index + 1}-${encodeURIComponent(id)}`;
}

function directoryUri(path: string): string {
	const uri = pathToFileURL(path).href;
	return uri.endsWith("/") ? uri : `${uri}/`;
}

function severityName(value: unknown): NotebookDiagnostic["severity"] {
	if (value === 1) return "error";
	if (value === 2) return "warning";
	if (value === 3) return "information";
	if (value === 4) return "hint";
	return "unknown";
}

function isRange(
	value: unknown,
): value is { start: { line: number; character: number }; end: { line: number; character: number } } {
	return isRecord(value) && isPosition(value["start"]) && isPosition(value["end"]);
}

function isPosition(value: unknown): value is { line: number; character: number } {
	return (
		isRecord(value) &&
		Number.isSafeInteger(value["line"]) &&
		(value["line"] as number) >= 0 &&
		Number.isSafeInteger(value["character"]) &&
		(value["character"] as number) >= 0
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
