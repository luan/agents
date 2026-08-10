import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, highlightCode } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { captureExecOutput } from "../context-guard/pi/capture.ts";
import { getCurrentContextGuardSessionId } from "../context-guard/pi/current-session.ts";
import { type CardTheme, darkerCardBackgroundAnsi, framedBlock } from "../shared/tui/card.ts";
import { EmptyComponent } from "../shared/tui/index.ts";
import { type KernelResponse, ProcessKernel } from "./process-kernel.ts";

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;

export type EvalLanguage = "js" | "ts" | "py";
type EvalKernelLanguage = "js" | "py";

interface EvalParams {
	code: string;
	language: EvalLanguage;
	title?: string;
	timeout?: number;
	reset?: boolean;
}

export interface EvalExecuteOptions {
	language: EvalLanguage;
	cwd: string;
	timeoutSeconds: number;
	signal?: AbortSignal;
}

export class EvalRuntime {
	private readonly kernels = new Map<EvalKernelLanguage, ProcessKernel>();

	reset(language?: EvalLanguage): void {
		if (language) {
			const kernelLanguage = language === "py" ? "py" : "js";
			this.kernels.get(kernelLanguage)?.reset();
			this.kernels.delete(kernelLanguage);
			return;
		}
		for (const kernel of this.kernels.values()) kernel.reset();
		this.kernels.clear();
	}

	execute(code: string, options: EvalExecuteOptions): Promise<KernelResponse> {
		return this.kernel(options.language).execute(code, options.cwd, options.timeoutSeconds, options.signal);
	}

	private kernel(language: EvalLanguage): ProcessKernel {
		const kernelLanguage = language === "py" ? "py" : "js";
		const existing = this.kernels.get(kernelLanguage);
		if (existing) return existing;
		const kernel =
			kernelLanguage === "js"
				? new ProcessKernel({
						command: "bun",
						args: [fileURLToPath(new URL("./js-process.ts", import.meta.url))],
						label: "JavaScript",
					})
				: new ProcessKernel({
						command: "uv",
						args: ["run", "--no-project", fileURLToPath(new URL("./python-process.py", import.meta.url))],
						label: "Python",
					});
		this.kernels.set(kernelLanguage, kernel);
		return kernel;
	}
}

export class EvalSessionRegistry {
	private readonly runtimes = new Map<string, EvalRuntime>();

	runtime(sessionId: string): EvalRuntime {
		let runtime = this.runtimes.get(sessionId);
		if (!runtime) {
			runtime = new EvalRuntime();
			this.runtimes.set(sessionId, runtime);
		}
		return runtime;
	}

	reset(sessionId?: string, language?: EvalLanguage): void {
		if (sessionId) {
			const runtime = this.runtimes.get(sessionId);
			runtime?.reset(language);
			if (!language) this.runtimes.delete(sessionId);
			return;
		}
		for (const runtime of this.runtimes.values()) runtime.reset();
		this.runtimes.clear();
	}
}

function parseParams(params: unknown): EvalParams {
	if (!params || typeof params !== "object") throw new Error("eval requires an object parameter");
	const record = params as Record<string, unknown>;
	if (typeof record.code !== "string" || record.code.trim() === "") {
		throw new Error("eval requires non-empty code");
	}
	return {
		code: record.code,
		language: record.language === "py" ? "py" : record.language === "ts" ? "ts" : "js",
		title: typeof record.title === "string" ? record.title : undefined,
		timeout: typeof record.timeout === "number" ? record.timeout : undefined,
		reset: record.reset === true,
	};
}

function formatEvalDuration(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined) return undefined;
	if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
	return `${(durationMs / 1000).toFixed(1)}s`;
}

function evalLanguageName(language: EvalLanguage | undefined): string {
	return language === "py" ? "Python" : language === "ts" ? "TypeScript" : "JavaScript";
}

function evalLanguageIconColor(language: EvalLanguage | undefined): string {
	return language === "py" ? "success" : language === "ts" ? "accent" : "warning";
}

function evalHeader(
	params: Partial<EvalParams>,
	theme: CardTheme,
	status: "running" | "completed" | "error",
	durationMs?: number,
): string {
	const language = evalLanguageName(params.language);
	const title = typeof params.title === "string" && params.title.trim() ? params.title.trim() : `${language} eval`;
	const statusColor = status === "error" ? "error" : status === "completed" ? "success" : "accent";
	const languageIcon = params.language === "py" ? "" : params.language === "ts" ? "" : "";
	const icon = `${theme.fg(evalLanguageIconColor(params.language), languageIcon)}${theme.fg(statusColor, "•")}`;
	const meta = [params.reset ? "reset" : undefined, status, formatEvalDuration(durationMs)]
		.filter(Boolean)
		.join(" · ");
	return `${icon} ${theme.fg("toolTitle", title)} ${theme.fg("dim", `· ${meta}`)}`;
}

function evalCodeLines(params: Partial<EvalParams>, expanded: boolean): string[] {
	const code = typeof params.code === "string" ? params.code.replace(/\t/g, "  ") : "";
	const allLines = code.split(/\r?\n/);
	const visible = expanded ? allLines : allLines.slice(-12);
	const hidden = allLines.length - visible.length;
	let highlighted: string[];
	try {
		highlighted = highlightCode(
			visible.join("\n"),
			params.language === "py" ? "python" : params.language === "ts" ? "typescript" : "javascript",
		);
	} catch {
		highlighted = visible;
	}
	if (hidden > 0) highlighted.unshift(`… ${hidden} earlier lines`);
	return highlighted;
}

function renderEvalCall(
	rawParams: unknown,
	theme: CardTheme,
	context: { isPartial?: boolean; isError?: boolean; expanded?: boolean },
) {
	if (context.isPartial === false) return new EmptyComponent();
	const params = rawParams && typeof rawParams === "object" ? (rawParams as Partial<EvalParams>) : {};
	const status = context.isPartial !== false ? "running" : context.isError ? "error" : "completed";
	return framedBlock(theme, {
		header: evalHeader(params, theme, status),
		sections: [{ lines: evalCodeLines(params, context.expanded === true) }],
		borderColor: status === "error" ? "error" : "accent",
		backgroundAnsi: darkerCardBackgroundAnsi(theme),
	});
}

function renderEvalResult(
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: { language?: EvalLanguage; title?: string; code?: string; status?: string; durationMs?: number };
	},
	{ expanded }: { expanded: boolean },
	theme: CardTheme,
	context: { args?: Partial<EvalParams>; isError?: boolean },
) {
	const params = { ...context.args, ...result.details };
	const output = result.content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.replace(/\n$/, "");
	const allOutputLines = output ? output.split(/\r?\n/) : [];
	const outputLines = expanded ? allOutputLines : allOutputLines.slice(-8);
	const hidden = allOutputLines.length - outputLines.length;
	if (hidden > 0) outputLines.unshift(`… ${hidden} earlier lines`);
	const failed = context.isError === true || result.details?.status === "error";
	return framedBlock(theme, {
		header: evalHeader(params, theme, failed ? "error" : "completed", result.details?.durationMs),
		sections: [
			{ lines: evalCodeLines(params, expanded) },
			...(outputLines.length > 0
				? [
						{
							label: theme.fg("toolTitle", "Output"),
							lines: outputLines.map((line) => theme.fg(failed ? "error" : "toolOutput", line)),
						},
					]
				: []),
		],
		borderColor: failed ? "error" : "dim",
		backgroundAnsi: darkerCardBackgroundAnsi(theme),
	});
}

export default function evalExtension(pi: ExtensionAPI): void {
	const registry = new EvalSessionRegistry();
	pi.on("session_shutdown", () => registry.reset());

	pi.registerTool({
		name: "eval",
		label: "eval",
		description:
			"Execute JavaScript, TypeScript, or Python in persistent session-scoped process kernels. State survives calls per language; reset recreates that language kernel. Use read(path) and display(value) for file analysis and structured output.",
		promptSnippet: "Evaluate persistent JavaScript/TypeScript or Python for data processing and large-file analysis.",
		promptGuidelines: [
			"Use eval for multi-step JavaScript/TypeScript or Python analysis where retained state is useful.",
			"Use read(path) inside eval to process files without loading them into the conversation.",
			"Use display(value), console.log(...), or print(...) for model-visible output.",
		],
		executionMode: "sequential",
		renderShell: "self",
		renderCall: renderEvalCall,
		renderResult: renderEvalResult,
		parameters: Type.Object(
			{
				code: Type.String({ description: "JavaScript, TypeScript, or Python cell body." }),
				language: Type.Optional(
					Type.Union([Type.Literal("js"), Type.Literal("ts"), Type.Literal("py")], {
						description: "Runtime language. Defaults to js. JavaScript and TypeScript share one kernel.",
					}),
				),
				title: Type.Optional(Type.String({ description: "Short transcript label." })),
				timeout: Type.Optional(
					Type.Number({ minimum: 1, maximum: MAX_TIMEOUT_SECONDS, description: "Timeout in seconds." }),
				),
				reset: Type.Optional(Type.Boolean({ description: "Reset retained state before this cell." })),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, rawParams, signal, _onUpdate, ctx: ExtensionContext) {
			const params = parseParams(rawParams);
			const sessionId = getCurrentContextGuardSessionId() ?? "default";
			const runtime = registry.runtime(sessionId);
			if (params.reset) runtime.reset(params.language);
			const timeout = Math.min(MAX_TIMEOUT_SECONDS, Math.max(1, params.timeout ?? DEFAULT_TIMEOUT_SECONDS));
			const startedAt = Date.now();
			let output = "";
			let error: string | undefined;
			let terminalState = "exited";
			try {
				const response = await runtime.execute(params.code, {
					language: params.language,
					cwd: ctx.cwd,
					timeoutSeconds: timeout,
					signal,
				});
				output = response.output;
				error = response.error;
			} catch (caught) {
				error = caught instanceof Error ? caught.message : String(caught);
				output = error;
				terminalState = signal?.aborted ? "cancelled" : error.includes("timed out") ? "timed_out" : "session_error";
			}
			if (error && output && !output.includes(error)) output = `${output}\n${error}`;
			const capture = await captureExecOutput(
				{
					projectDir: ctx.cwd,
					sessionId,
					sourceKind: "eval",
					label: params.title ?? `${evalLanguageName(params.language)} eval`,
					metadata: { language: params.language, title: params.title, code: params.code },
					cwd: ctx.cwd,
				},
				{
					output,
					exitCode: error ? 1 : 0,
					terminalState,
					elapsedMs: Date.now() - startedAt,
				},
			);
			const visible = capture.capture?.preview ?? output;
			return {
				content: [{ type: "text", text: visible }],
				details: {
					language: params.language,
					title: params.title,
					code: params.code,
					status: error ? "error" : "completed",
					durationMs: Date.now() - startedAt,
					artifactId: capture.capture?.artifactId,
					captureFailure: capture.failure,
				},
				isError: Boolean(error),
			};
		},
	});
}
