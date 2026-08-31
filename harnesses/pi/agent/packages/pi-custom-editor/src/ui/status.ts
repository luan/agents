import { basename } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { activityPresentationFrame, getTuiAppearance, requestPhaseAnimation, tuiTheme } from "pi-libtui";
import { type EditorCompositionStatus, type EditorStatusSeparator, editorStatusSeparator } from "pi-libtui/editor";
import type { StatusSegmentId } from "../core/composition.ts";
import { formatDuration, type TuiState } from "../runtime/state.ts";

export type Usage = { input: number; output: number; cost: number };

function count(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	if (value >= 1000) return `${Math.round(value / 1000)}k`;
	return `${value}`;
}

function contextPreset(status: string | undefined, theme: Theme): { qualifier?: string; paint(text: string): string } {
	const plain = status ? stripTerminalSequences(status) : "";
	const label = plain.match(/^([a-z]+)/iu)?.[1];
	return {
		qualifier: label ? label.toLowerCase() : undefined,
		paint: status && plain ? (text) => status.replace(plain, text) : (text) => tuiTheme(theme).fg("accent", text),
	};
}

export function readUsage(ctx: ExtensionContext): Usage {
	const total: Usage = { input: 0, output: 0, cost: 0 };
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		total.input += entry.message.usage?.input ?? 0;
		total.output += entry.message.usage?.output ?? 0;
		total.cost += entry.message.usage?.cost?.total ?? 0;
	}
	return total;
}

export function workingStatus(state: TuiState, theme: Theme, width: number): string {
	const colors = tuiTheme(theme);
	if (!state.active) {
		return state.lastTurnMs === undefined
			? ""
			: colors.fg(
					"text.muted",
					`Last ${formatDuration(state.lastTurnMs)} · total ${formatDuration(state.cumulativeMs)}`,
				);
	}
	const appearance = getTuiAppearance();
	const elapsed = state.elapsed();
	const timing = colors.fg(
		"text.muted",
		` ${formatDuration(elapsed)} · total ${formatDuration(state.cumulativeMs + elapsed)}`,
	);
	const frame = activityPresentationFrame(
		colors,
		requestPhaseAnimation("working", appearance),
		"working",
		state.fastMode ? "Zipping" : "Working",
		elapsed,
		Math.max(1, width - visibleWidth(timing)),
		{ animationSpeed: appearance.animationSpeed, animationSmoothness: appearance.animationSmoothness },
	);
	const activity = `${frame.marker}${frame.marker && frame.text ? " " : ""}${frame.text}`;
	return truncateToWidth(`${activity}${timing}`, width, "");
}

export function contextStatus(
	ctx: ExtensionContext,
	usage: Usage,
	theme: Theme,
	width: number,
	contextWindowStatus?: string,
): string {
	const colors = tuiTheme(theme);
	const context = ctx.getContextUsage();
	if (!context || context.contextWindow <= 0) return colors.fg("text.muted", "ctx no model");
	const percent = Math.max(0, Math.min(100, context.percent ?? ((context.tokens ?? 0) / context.contextWindow) * 100));
	const preset = contextPreset(contextWindowStatus, theme);
	const metric = preset.paint(`${percent.toFixed(1)}% ${count(context.tokens ?? 0)}/${count(context.contextWindow)}`);
	const suffix = [
		metric,
		usage.input || usage.output ? colors.fg("text.muted", `↑${count(usage.input)} ↓${count(usage.output)}`) : "",
		usage.cost ? colors.fg("positive", `$${usage.cost.toFixed(2)}`) : "",
		preset.qualifier ? preset.paint(`(${preset.qualifier})`) : "",
	]
		.filter(Boolean)
		.join(" ");
	const prefix = colors.fg("text.muted", "ctx ");
	const gaugeWidth = Math.min(16, Math.max(4, width - visibleWidth(prefix) - visibleWidth(suffix) - 1));
	const usedWidth = percent <= 0 ? 0 : Math.max(1, Math.min(gaugeWidth, Math.ceil((gaugeWidth * percent) / 100)));
	const gauge = `${preset.paint("━".repeat(usedWidth))}${colors.fg("text.muted", "─".repeat(gaugeWidth - usedWidth))}`;
	return truncateToWidth(`${prefix}${gauge} ${suffix}`, width, "");
}

function cwdLabel(cwd: string): string {
	const home = process.env.HOME;
	if (home && (cwd === home || cwd.startsWith(`${home}/`))) return `~${cwd.slice(home.length)}`;
	return cwd || basename(cwd);
}

export interface StatusRenderOptions {
	readonly ctx: ExtensionContext;
	readonly state: TuiState;
	readonly theme: Theme;
	readonly left: readonly StatusSegmentId[];
	readonly right: readonly StatusSegmentId[];
	readonly separator: EditorStatusSeparator;
	readonly width: number;
	readonly getThinkingLabel?: () => string | undefined;
}

export function renderStatusGroups(options: StatusRenderOptions): EditorCompositionStatus {
	const { ctx, state, theme } = options;
	const colors = tuiTheme(theme);
	const usage = readUsage(ctx);
	const context = ctx.getContextUsage();
	const contextMeta = contextPreset(state.contextStatus, theme);
	const sessionName = ctx.sessionManager.getSessionName();
	const model = ctx.model?.name ?? "no-model";
	const provider = ctx.model?.provider ?? "";
	const thinking = options.getThinkingLabel?.();
	const segment = (id: StatusSegmentId): string => {
		switch (id) {
			case "role":
				return state.roleStatus ?? "";
			case "provider":
				return provider ? colors.fg("text.secondary", provider) : "";
			case "model":
				return colors.fg("text.secondary", model);
			case "thinking":
				return thinking && thinking !== "off" ? colors.fg("accent", thinking) : "";
			case "fast":
				return state.fastMode ? colors.fg("warning", "fast") : "";
			case "path":
				return colors.fg("accent", cwdLabel(ctx.cwd));
			case "git":
				return state.branch ? colors.fg("positive", state.branch) : "";
			case "session":
				return colors.fg("text.muted", sessionName ?? ctx.sessionManager.getSessionId().slice(0, 8));
			case "working":
				return workingStatus(state, theme, Math.max(12, Math.floor(options.width / 2)));
			case "elapsed":
				return colors.fg("text.muted", formatDuration(state.active ? state.elapsed() : (state.lastTurnMs ?? 0)));
			case "context":
				return contextStatus(ctx, usage, theme, Math.max(18, Math.floor(options.width / 2)), state.contextStatus);
			case "context-window":
				return context?.contextWindow ? contextMeta.paint(count(context.contextWindow)) : "";
			case "context-qualifier":
				return contextMeta.qualifier ? contextMeta.paint(contextMeta.qualifier) : "";
			case "tokens":
				return usage.input || usage.output
					? colors.fg("text.muted", `↑${count(usage.input)} ↓${count(usage.output)}`)
					: "";
			case "cost":
				return usage.cost ? colors.fg("positive", `$${usage.cost.toFixed(2)}`) : "";
			case "clock":
				return colors.fg("text.muted", new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
		}
	};
	const separator = colors.fg("text.muted", editorStatusSeparator(options.separator));
	const render = (ids: readonly StatusSegmentId[]) => ids.map(segment).filter(Boolean).join(separator);
	return { left: render(options.left), right: render(options.right) };
}
