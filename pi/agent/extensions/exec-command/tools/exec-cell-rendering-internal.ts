import { keyHint } from "@earendil-works/pi-coding-agent";
import { italic, pulseGlyph, renderTokenCost, runningFrame, shineText } from "../../shared/tui";
import { shellSplit } from "../shell/tokenize.ts";
import type { ExecCommandStatus } from "./exec-command-state.ts";

export interface RenderTheme {
	fg(role: string, text: string): string;
	bold(text: string): string;
	getBgAnsi?(role: "toolPendingBg" | "toolSuccessBg" | "toolErrorBg"): string;
}

export interface RenderOutputBlockOptions {
	expanded?: boolean;
	maxLines?: number;
	truncatedAbove?: boolean;
	originalTokenCount?: number;
	width?: number;
}

const DEFAULT_OUTPUT_MAX_LINES = 5;
const COMMAND_DISPLAY_WRAP_CHARS = 180;
const COMMAND_DISPLAY_MAX_LINES = 4;
const COMMAND_PREVIEW_MAX_CHARS = 100;
const OUTPUT_LINE_DISPLAY_MAX_CHARS = 220;
const RUNNING_FRAME_MS = 120;
const BACKGROUND_LABEL = "background terminal";
export interface TerminalSessionView {
	operation: "start" | "logs" | "wait";
	processId: number | string;
	command?: string;
	running?: boolean;
	exitCode?: number;
	elapsedMs?: number;
	cursor?: number;
}

export function renderTerminalSessionRow(session: TerminalSessionView, theme: RenderTheme): string {
	const separator = theme.fg("dim", " · ");
	let text = `${theme.fg("accent", "")} ${theme.fg("accent", "Background terminal:")} ${theme.fg(
		"muted",
		`#${session.processId}`,
	)}`;
	if (session.command) {
		text += `${separator}${theme.fg("muted", formatCommandPreview(session.command) ?? session.command)}`;
	}
	const state = session.running ? "running" : "exited";
	text += `${separator}${theme.fg(session.running ? "success" : "muted", state)}`;
	if (session.exitCode !== undefined) {
		text += `${separator}${theme.fg(session.exitCode === 0 ? "muted" : "error", `exit ${session.exitCode}`)}`;
	}
	if (session.elapsedMs !== undefined) {
		text += `${separator}${theme.fg("muted", formatTerminalSessionDuration(session.elapsedMs))}`;
	}
	return text;
}

function formatTerminalSessionDuration(elapsedMs: number): string {
	const ms = Math.max(0, elapsedMs);
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) {
		const seconds = ms / 1_000;
		return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
	}
	return formatElapsedTime(ms);
}

function shellLanguage(shell: string | undefined): { name: string; color: string } {
	const executable = shell
		?.replace(/\\/g, "/")
		.split("/")
		.pop()
		?.toLowerCase()
		.replace(/\.exe$/, "");
	switch (executable) {
		case "bash":
			return { name: "Bash", color: "warning" };
		case "zsh":
			return { name: "Zsh", color: "accent" };
		case "fish":
			return { name: "Fish", color: "success" };
		case "sh":
		case "dash":
			return { name: "Shell", color: "muted" };
		default:
			return { name: executable || "Shell", color: "toolTitle" };
	}
}

export function renderShellCardHeader(
	shell: string | undefined,
	state: ExecCommandStatus,
	theme: RenderTheme,
	failed = false,
	elapsedMs?: number,
	processId?: number | string,
	outputTokens?: number,
	exitCode?: number,
): string {
	const language = shellLanguage(shell);
	const icon = theme.fg(language.color, "");
	// A `(0)` on every successful header is noise, so only a non-zero code earns the parenthetical.
	const code = state === "running" || exitCode === undefined || exitCode === 0 ? "" : ` (${exitCode})`;
	const status =
		state === "running"
			? "running"
			: `${failed ? "failed" : processId === undefined ? "completed" : "exited"}${code}`;
	const meta = [
		processId === undefined ? undefined : `#${processId}`,
		status,
		elapsedMs === undefined ? undefined : formatTerminalSessionDuration(elapsedMs),
	].filter((value): value is string => value !== undefined);
	let text = `${icon} ${theme.fg("toolTitle", language.name)} ${theme.fg("dim", meta.join(" · "))}`;
	if (outputTokens !== undefined) {
		const separator = meta.length > 0 ? theme.fg("dim", " · ") : "";
		text += `${separator}${renderTokenCost(theme, outputTokens, "exec_command")}`;
	}
	return text;
}

export function renderExecCommandCall(
	command: string,
	state: ExecCommandStatus,
	theme: RenderTheme,
	failed = false,
	elapsedMs?: number,
	captureWrapped = false,
): string {
	return renderCommandText(command, state, theme, failed, elapsedMs, captureWrapped);
}

export function renderSpawnedBackgroundTerminalCall(
	command: string,
	theme: RenderTheme,
	captureWrapped = false,
	session?: Omit<TerminalSessionView, "operation" | "command">,
): string {
	if (session) return renderTerminalSessionRow({ ...session, operation: "start", command }, theme);
	return renderCommandText(command, "done", theme, false, undefined, captureWrapped, {
		done: "Spawned background terminal",
		running: "Spawning background terminal",
	});
}

export function renderUserExecCommandCall(
	command: string,
	state: ExecCommandStatus,
	theme: RenderTheme,
	failed = false,
	elapsedMs?: number,
): string {
	return renderCommandText(command, state, theme, failed, elapsedMs, false, {
		done: "You ran",
		running: "You are running",
	});
}

export function renderWriteStdinCall(
	sessionId: number | string,
	input: string | undefined,
	command: string | undefined,
	theme: RenderTheme,
	state: ExecCommandStatus = "done",
	failed = false,
	elapsedMs?: number,
	stdinOpen?: boolean,
): string {
	const interacted = typeof input === "string" && input.length > 0;
	const marker = state === "running" ? `${runningMarker(elapsedMs)} ` : interacted ? "↳ " : "• ";
	const title =
		state === "running"
			? interacted
				? "Interacting with background terminal"
				: "Waiting for background terminal"
			: interacted
				? "Interacted with background terminal"
				: "Waited for background terminal";
	let text = appendElapsed(
		`${renderStatusMarker(marker, state, theme, failed)}${theme.bold(title)}`,
		state,
		theme,
		elapsedMs,
	);
	const commandPreview = formatCommandPreview(command);
	if (commandPreview) {
		text += `${theme.fg("dim", " · ")}${theme.fg("muted", commandPreview)}`;
	}
	// Keep the session fallback only when we do not have a stable command display.
	if (!commandPreview) {
		text += `${theme.fg("dim", " ")}${theme.fg("muted", `#${sessionId}`)}`;
	}
	if (stdinOpen) {
		text += `${theme.fg("dim", " · ")}${theme.fg("mdLink", formatStdinCapability(stdinOpen))}`;
	}
	return text;
}

export function renderBackgroundTerminalHudLine(
	command: string | undefined,
	output: string,
	theme: RenderTheme,
	elapsedMs: number,
	width = 120,
	stdinOpen?: boolean,
): string {
	const lineCount = outputLineCount(output);
	const outputSummary =
		lineCount > 0
			? {
					count: `(${lineCount} ${lineCount === 1 ? "line" : "lines"})`,
					lastLine: lastOutputLine(output),
				}
			: {
					count: "(no output)",
					lastLine: undefined,
				};
	const commandPreview = shortenCommand(
		formatCommandPreview(command) ?? `#background`,
		Math.max(16, Math.floor(width * 0.4)),
	);
	const fixedVisibleLength =
		2 +
		"background terminal".length +
		" · ".length +
		formatElapsedTime(elapsedMs).length +
		" · ".length +
		commandPreview.length +
		" · ".length +
		outputSummary.count.length +
		(stdinOpen ? " · ".length + formatStdinCapability(stdinOpen).length : 0) +
		(outputSummary.lastLine ? " · ".length : 0);
	const lastLineMax = Math.max(12, width - fixedVisibleLength);
	let text = `${backgroundTerminalPulseMarker(theme, elapsedMs)} ${backgroundTerminalAnimatedLabel(theme, elapsedMs)}`;
	text += `${theme.fg("dim", " · ")}${theme.fg("dim", formatElapsedTime(elapsedMs))}`;
	if (stdinOpen) {
		text += `${theme.fg("dim", " · ")}${theme.fg("mdLink", formatStdinCapability(stdinOpen))}`;
	}
	text += `${theme.fg("dim", " · ")}${theme.fg("muted", outputSummary.count)}`;
	if (outputSummary.lastLine) {
		text += `${theme.fg("dim", " · ")}${theme.fg("dim", shortenLine(stripAnsi(outputSummary.lastLine), lastLineMax))}`;
	}
	text += `${theme.fg("dim", " · ")}${theme.fg("muted", commandPreview)}`;
	return text;
}

export function formatStdinCapability(stdinOpen: boolean): string {
	return stdinOpen ? "tty" : "";
}

export function renderOutputBlock(
	output: string,
	theme: Pick<RenderTheme, "fg">,
	footer?: string,
	options: RenderOutputBlockOptions = {},
): string {
	return renderTerminalOutputLines(output, theme, footer, options)
		.map((line, index) => `${theme.fg("dim", index === 0 ? "  └ " : "    ")}${line}`)
		.join("\n");
}

export function renderTerminalOutputLines(
	output: string,
	theme: Pick<RenderTheme, "fg">,
	footer?: string,
	options: RenderOutputBlockOptions = {},
): string[] {
	const text = output.length > 0 ? output.replace(/\n$/, "") : "(no output)";
	let lines = text.split("\n");
	if (options.truncatedAbove) {
		lines.unshift(formatTruncatedAboveLine(options.originalTokenCount));
	}
	lines = limitOutputLines(lines, options);
	if (footer) lines.push(footer);
	return lines.map((line) => styleOutputLine(line, theme));
}

function limitOutputLines(lines: string[], options: RenderOutputBlockOptions): string[] {
	if (options.expanded) return lines;
	const maxLines = options.maxLines ?? DEFAULT_OUTPUT_MAX_LINES;
	if (maxLines <= 0) return lines;
	if (options.width !== undefined) return limitOutputRows(lines, maxLines, options.width);
	if (lines.length <= maxLines) return lines;
	if (maxLines === 1) return [formatOmittedLines(lines.length)];

	const visibleLines = maxLines - 1;
	const headCount = Math.floor(visibleLines / 2);
	const tailCount = visibleLines - headCount;
	const omitted = lines.length - headCount - tailCount;
	return [...lines.slice(0, headCount), formatOmittedLines(omitted), ...lines.slice(lines.length - tailCount)];
}

function limitOutputRows(lines: string[], maxRows: number, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const rowCounts = lines.map((line) => outputLineRows(line, safeWidth));
	const totalRows = rowCounts.reduce((sum, rows) => sum + rows, 0);
	if (totalRows <= maxRows) return lines;
	if (maxRows === 1) return [formatOmittedLines(lines.length)];

	const ellipsisRows = outputLineRows(formatOmittedLines(lines.length), safeWidth);
	if (ellipsisRows >= maxRows) return [formatOmittedLines(lines.length)];

	const availableRows = maxRows - ellipsisRows;
	const headBudget = Math.floor(availableRows / 2);
	const tailBudget = availableRows - headBudget;
	let headEnd = 0;
	let headRows = 0;
	while (headEnd < lines.length && headRows + rowCounts[headEnd]! <= headBudget) {
		headRows += rowCounts[headEnd]!;
		headEnd += 1;
	}

	let tailStart = lines.length;
	let tailRows = 0;
	while (tailStart > headEnd && tailRows + rowCounts[tailStart - 1]! <= tailBudget) {
		tailStart -= 1;
		tailRows += rowCounts[tailStart]!;
	}

	const omitted = lines.length - headEnd - (lines.length - tailStart);
	return [...lines.slice(0, headEnd), formatOmittedLines(omitted), ...lines.slice(tailStart)];
}

function outputLineRows(line: string, width: number): number {
	const prefixWidth = 4;
	const contentWidth = stripAnsi(line).length;
	return Math.max(1, Math.ceil((prefixWidth + contentWidth) / width));
}

function formatOmittedLines(omitted: number): string {
	return `… +${omitted} lines (${keyHint("app.tools.expand", "transcript")})`;
}

function stripAnsi(value: string): string {
	return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function outputLineCount(output: string): number {
	if (output.length === 0) return 0;
	return output.replace(/\n$/, "").split("\n").length;
}

export function lastOutputLine(output: string): string | undefined {
	if (output.length === 0) return undefined;
	const lines = output.replace(/\n$/, "").split("\n");
	return lines[lines.length - 1];
}

function formatTruncatedAboveLine(originalTokenCount: number | undefined): string {
	if (originalTokenCount !== undefined) {
		return `… output truncated above (original ~${originalTokenCount} tokens)`;
	}
	return "… output truncated above";
}

export function renderTerminalCommandHeader(
	command: string,
	_state: ExecCommandStatus,
	theme: RenderTheme,
	_failed = false,
	_elapsedMs?: number,
	_captureWrapped = false,
): string {
	const [firstLine = "", ...continuationLines] = wrapCommandForDisplay(stripShellWrapper(command));
	let text = `${theme.bold("$")} ${highlightShellCommand(firstLine, theme)}`;
	for (const line of continuationLines) {
		text += `\n${theme.fg("dim", "  ")}${highlightShellCommand(line, theme)}`;
	}
	return text;
}

function renderCommandText(
	command: string,
	state: ExecCommandStatus,
	theme: RenderTheme,
	failed: boolean,
	elapsedMs?: number,
	captureWrapped = false,
	labels: { done: string; running: string } = { done: "Ran", running: "Running" },
): string {
	const verb = state === "running" ? labels.running : labels.done;
	const marker = state === "running" ? runningMarker(elapsedMs) : "•";
	const [firstLine = "", ...continuationLines] = wrapCommandForDisplay(stripShellWrapper(command));
	let text = appendElapsed(
		appendRoutingMarkers(
			`${renderStatusMarker(marker, state, theme, failed)} ${theme.bold(verb)} ${highlightShellCommand(firstLine, theme)}`,
			theme,
			{ captureWrapped },
		),
		state,
		theme,
		elapsedMs,
	);
	for (const line of continuationLines) {
		text += `\n${theme.fg("dim", "    ")}${highlightShellCommand(line, theme)}`;
	}
	return text;
}

function appendRoutingMarkers(
	text: string,
	theme: Pick<RenderTheme, "fg">,
	options: { captureWrapped?: boolean },
): string {
	const markers = [options.captureWrapped ? "via artifact-store" : undefined].filter(
		(marker): marker is string => marker !== undefined,
	);
	if (markers.length === 0) return text;
	return `${text}${markers
		.map((marker) => `${theme.fg("dim", " · ")}${theme.fg("mdLink", italic(marker))}`)
		.join("")}`;
}

function appendElapsed(
	text: string,
	state: ExecCommandStatus,
	theme: Pick<RenderTheme, "fg">,
	elapsedMs: number | undefined,
): string {
	if (state !== "running" || elapsedMs === undefined) return text;
	return `${text}${theme.fg("dim", ` · ${formatElapsedTime(elapsedMs)}`)}`;
}

export function formatElapsedTime(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes === 0) return `${seconds}s`;
	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);
	if (hours === 0) return `${totalMinutes}m ${seconds.toString().padStart(2, "0")}s`;
	return `${hours}h ${minutes.toString().padStart(2, "0")}m ${seconds.toString().padStart(2, "0")}s`;
}

function renderStatusMarker(
	marker: string,
	state: ExecCommandStatus,
	theme: Pick<RenderTheme, "fg">,
	failed: boolean,
): string {
	if (state === "running") return theme.fg("dim", marker);
	return theme.fg(failed ? "error" : "success", marker);
}

function runningMarker(elapsedMs: number | undefined): string {
	return runningFrame(elapsedMs, RUNNING_FRAME_MS);
}

export function backgroundTerminalPulseMarker(theme: Pick<RenderTheme, "fg">, elapsedMs: number | undefined): string {
	return pulseGlyph(theme, "●", elapsedMs, {
		role: "accent",
		periodMs: 1_200,
		lowScale: 0.45,
		highScale: 1.45,
	});
}

export function backgroundTerminalAnimatedLabel(theme: RenderTheme, elapsedMs: number | undefined): string {
	return shineText(theme, BACKGROUND_LABEL, elapsedMs, {
		role: "accent",
		fallback: (text) => theme.bold(text),
	});
}

function styleOutputLine(line: string, theme: Pick<RenderTheme, "fg">): string {
	if (/\u001b\[[0-?]*[ -/]*[@-~]/.test(line)) return line;
	return theme.fg("dim", shortenLine(line, OUTPUT_LINE_DISPLAY_MAX_CHARS));
}

function shortenCommand(command: string, max = 100): string {
	const trimmed = command.trim();
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max - 3)}...`;
}

function wrapCommandForDisplay(command: string): string[] {
	const trimmed = command.trim();
	if (trimmed.length <= COMMAND_DISPLAY_WRAP_CHARS) return [trimmed];

	const lines: string[] = [];
	let remaining = trimmed;
	while (remaining.length > 0 && lines.length < COMMAND_DISPLAY_MAX_LINES) {
		if (remaining.length <= COMMAND_DISPLAY_WRAP_CHARS) {
			lines.push(remaining);
			remaining = "";
			break;
		}
		const slice = remaining.slice(0, COMMAND_DISPLAY_WRAP_CHARS + 1);
		const whitespaceIndex = slice.lastIndexOf(" ");
		const splitIndex =
			whitespaceIndex >= Math.floor(COMMAND_DISPLAY_WRAP_CHARS / 2) ? whitespaceIndex : COMMAND_DISPLAY_WRAP_CHARS;
		lines.push(remaining.slice(0, splitIndex).trimEnd());
		remaining = remaining.slice(splitIndex).trimStart();
	}
	if (remaining.length > 0) {
		const lastIndex = lines.length - 1;
		lines[lastIndex] = `${lines[lastIndex]!.slice(0, COMMAND_DISPLAY_WRAP_CHARS - 3)}...`;
	}
	return lines;
}

function shortenLine(line: string, max: number): string {
	if (line.length <= max) return line;
	return `${line.slice(0, max - 3)}...`;
}

function formatCommandPreview(command: string | undefined): string | undefined {
	if (!command) return undefined;
	const singleLine = command.replace(/\s+/g, " ").trim();
	if (singleLine.length === 0) return undefined;
	return shortenCommand(stripShellWrapper(singleLine), COMMAND_PREVIEW_MAX_CHARS);
}

function stripShellWrapper(command: string): string {
	const trimmed = command.trim();
	const tokens = shellSplit(trimmed);
	if (tokens.length === 3 && (tokens[1] === "-c" || tokens[1] === "-lc")) {
		const shell = tokens[0]?.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
		if (shell === "bash" || shell === "zsh" || shell === "sh") {
			return tokens[2] ?? trimmed;
		}
	}
	return trimmed;
}

function highlightShellCommand(command: string, theme: RenderTheme): string {
	const segments = tokenizeShellHighlight(command);
	return segments.map((segment) => (segment.role ? theme.fg(segment.role, segment.text) : segment.text)).join("");
}

type ShellHighlightSegment = { text: string; role?: string };

function tokenizeShellHighlight(command: string): ShellHighlightSegment[] {
	const segments: ShellHighlightSegment[] = [];
	let index = 0;
	let expectingCommand = true;

	const push = (text: string, role?: string) => {
		if (text.length === 0) return;
		segments.push(role ? { text, role } : { text });
	};

	while (index < command.length) {
		const char = command[index]!;
		const next = command[index + 1];

		if (/\s/.test(char)) {
			const start = index;
			while (index < command.length && /\s/.test(command[index]!)) index += 1;
			const whitespace = command.slice(start, index);
			push(whitespace);
			if (whitespace.includes("\n")) expectingCommand = true;
			continue;
		}

		if (char === "#") {
			const start = index;
			while (index < command.length && command[index] !== "\n") index += 1;
			push(command.slice(start, index), "syntaxComment");
			continue;
		}

		if ((char === "$" && (next === "'" || next === '"')) || char === "'" || char === '"') {
			const start = index;
			const quote = char === "$" ? next! : char;
			index += char === "$" ? 2 : 1;
			while (index < command.length) {
				if (command[index] === "\\" && quote === '"') {
					index = Math.min(index + 2, command.length);
					continue;
				}
				if (command[index] === quote) {
					index += 1;
					break;
				}
				index += 1;
			}
			push(command.slice(start, index), "syntaxString");
			expectingCommand = false;
			continue;
		}

		if (char === "$") {
			const end = variableEnd(command, index);
			push(command.slice(index, end), "syntaxVariable");
			index = end;
			expectingCommand = false;
			continue;
		}

		const operator = readOperator(command, index);
		if (operator) {
			push(operator, operator === "(" || operator === ")" ? "syntaxPunctuation" : "syntaxOperator");
			index += operator.length;
			if (operator === "&&" || operator === "||" || operator === "|" || operator === ";" || operator === "(") {
				expectingCommand = true;
			}
			continue;
		}

		const start = index;
		while (index < command.length && !/\s/.test(command[index]!) && !startsSpecial(command, index)) {
			index += 1;
		}
		const word = command.slice(start, index);
		const displayWord = displayCommandWord(word, expectingCommand);
		const role = roleForWord(displayWord, expectingCommand);
		push(displayWord, role);
		if (expectingCommand && isEnvironmentAssignment(word)) {
			expectingCommand = true;
		} else if (expectingCommand && COMMAND_PREFIXES.has(displayWord)) {
			expectingCommand = true;
		} else {
			expectingCommand = false;
		}
	}

	return segments;
}

const COMMAND_PREFIXES = new Set(["builtin", "command", "env", "exec", "noglob", "sudo", "time"]);
const SHELL_KEYWORDS = new Set([
	"case",
	"do",
	"done",
	"elif",
	"else",
	"esac",
	"fi",
	"for",
	"function",
	"if",
	"in",
	"select",
	"then",
	"until",
	"while",
]);

function displayCommandWord(word: string, expectingCommand: boolean): string {
	if (!expectingCommand || !word.startsWith("/")) return word;
	return word.slice(word.lastIndexOf("/") + 1) || word;
}

function roleForWord(word: string, expectingCommand: boolean): string | undefined {
	if (SHELL_KEYWORDS.has(word)) return "syntaxKeyword";
	if (isEnvironmentAssignment(word)) return "syntaxVariable";
	if (word.startsWith("-") && word !== "-") return "syntaxKeyword";
	if (expectingCommand) return "syntaxFunction";
	return undefined;
}

function isEnvironmentAssignment(word: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function startsSpecial(command: string, index: number): boolean {
	const char = command[index];
	if (char === "'" || char === '"' || char === "$") return true;
	return readOperator(command, index) !== undefined;
}

function readOperator(command: string, index: number): string | undefined {
	const three = command.slice(index, index + 3);
	if (three === "<<<" || three === ">&-" || three === "<&-") return three;
	const two = command.slice(index, index + 2);
	if (
		two === "&&" ||
		two === "||" ||
		two === ">>" ||
		two === "<<" ||
		two === ">|" ||
		two === ">&" ||
		two === "<&" ||
		/^[0-9][<>]$/.test(two)
	)
		return two;
	const char = command[index];
	return char && "|;&()<>".includes(char) ? char : undefined;
}

function variableEnd(command: string, start: number): number {
	const next = command[start + 1];
	if (!next) return start + 1;
	if (next === "{") return balancedEnd(command, start, "{", "}");
	if (next === "(") return balancedEnd(command, start, "(", ")");
	if (/[A-Za-z_]/.test(next)) {
		let index = start + 2;
		while (index < command.length && /[A-Za-z0-9_]/.test(command[index]!)) index += 1;
		return index;
	}
	if (/[0-9?#@*!$-]/.test(next)) return start + 2;
	return start + 1;
}

function balancedEnd(command: string, start: number, open: string, close: string): number {
	let depth = 0;
	for (let index = start + 1; index < command.length; index += 1) {
		const char = command[index];
		if (char === "\\") {
			index += 1;
			continue;
		}
		if (char === open) depth += 1;
		if (char === close) {
			depth -= 1;
			if (depth === 0) return index + 1;
		}
	}
	return command.length;
}
