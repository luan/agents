import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { PolishedTuiConfig } from "./config";
import { emptyGitStatus, type GitStatusSummary } from "./git";
import type { RuntimeInfo } from "./runtime";
import type { UsageSnapshot } from "./usage";

const BAR_FILLED = "━";
const BAR_EMPTY = "─";
const CTX_GAUGE_WIDTH = 12;

export type FooterRenderState = GitStatusSummary & {
	modelLabel: string;
	providerLabel: string;
	thinkingLevel?: string;
	contextPercent: number | null;
	contextUsed: number;
	contextTotal: number;
	tokenLabel: string;
	costLabel: string;
	hasTokens: boolean;
	hasCost: boolean;
	runtime?: RuntimeInfo;
	usage?: UsageSnapshot | null;
	usageLines?: string[];
};

export function emptyFooterState(): FooterRenderState {
	return {
		modelLabel: "no-model",
		providerLabel: "Unknown",
		thinkingLevel: undefined,
		contextPercent: null,
		contextUsed: 0,
		contextTotal: 0,
		tokenLabel: "↑0 ↓0",
		costLabel: "$0.00",
		hasTokens: false,
		hasCost: false,
		runtime: undefined,
		usage: null,
		usageLines: undefined,
		...emptyGitStatus(),
	};
}

function formatTokenCount(tokens: number): string {
	if (tokens >= 1_000_000) {
		const m = tokens / 1_000_000;
		return m % 1 === 0 ? `${m}M` : `${m.toFixed(1).replace(/\.0$/, "")}M`;
	}
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return `${tokens}`;
}

function formatCwdLabel(cwd: string, cwdIcon: string): string {
	let pwd = cwd;
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;
	return cwdIcon ? `${cwdIcon} ${pwd}` : pwd;
}

function fitFooterSegment(width: number, variants: string[]): string {
	const safeWidth = Math.max(1, width);
	for (const variant of variants) {
		if (visibleWidth(variant) <= safeWidth) return variant;
	}
	return truncateToWidth(variants[variants.length - 1] || "", safeWidth);
}

function wrapFooterSegments(segments: string[], width: number, sep: string): string[] {
	const safeWidth = Math.max(1, width);
	const lines: string[] = [];
	let current = "";

	for (const segment of segments.filter(Boolean)) {
		const fitted = truncateToWidth(segment, safeWidth);
		if (!current) {
			current = fitted;
			continue;
		}
		const candidate = current + sep + fitted;
		if (visibleWidth(candidate) <= safeWidth) {
			current = candidate;
			continue;
		}
		lines.push(truncateToWidth(current, safeWidth));
		current = fitted;
	}

	if (current) lines.push(truncateToWidth(current, safeWidth));
	return lines;
}

function renderContextGauge(
	state: FooterRenderState,
	theme: Theme,
	options: { barWidth: number; includeCounts: boolean },
): string {
	const barWidth = Math.max(4, options.barWidth);
	const rawPercent = state.contextPercent ?? 0;
	const clamped = Math.max(0, Math.min(100, rawPercent));
	const filled = Math.round((clamped / 100) * barWidth);
	const empty = barWidth - filled;

	let color: ThemeColor;
	if (clamped >= 90) color = "error";
	else if (clamped >= 70) color = "warning";
	else if (clamped >= 50) color = "accent";
	else color = "success";

	const bar = theme.fg(color, BAR_FILLED.repeat(filled)) + theme.fg("dim", BAR_EMPTY.repeat(empty));
	const pctValue = state.contextPercent === null ? "?" : `${Math.round(rawPercent)}%`;
	const counts =
		!options.includeCounts || !state.contextTotal
			? ""
			: ` ${formatTokenCount(state.contextUsed)}/${formatTokenCount(state.contextTotal)}`;

	return `${theme.fg("dim", "ctx ") + bar} ${theme.fg("dim", pctValue + counts)}`;
}

function getRuntimeColorToken(runtime: RuntimeInfo | undefined): ThemeColor {
	switch (runtime?.name) {
		case "nodejs":
			return "success";
		case "deno":
			return "syntaxType";
		case "bun":
		case "python":
		case "java":
			return "warning";
		case "rust":
		case "ruby":
			return "error";
		case "golang":
			return "syntaxType";
		case "lua":
		case "php":
			return "accent";
		default:
			return "text";
	}
}

function renderRuntimeSegment(theme: Theme, runtime: RuntimeInfo | undefined): string {
	if (!runtime) return "";
	const label = runtime.version ? `${runtime.symbol} ${runtime.version}` : runtime.symbol;
	return theme.fg(getRuntimeColorToken(runtime), label);
}

function renderBranchSegment(theme: Theme, state: FooterRenderState, config: PolishedTuiConfig): string {
	const branch = state.branch;
	if (!branch) return "";

	const branchColor = state.dirty ? "warning" : "success";
	let str = theme.fg(branchColor, branch);
	if (state.dirty) str += theme.fg("warning", " *");
	if (state.ahead) str += theme.fg("success", ` ${config.icons.ahead}${state.ahead}`);
	if (state.behind) str += theme.fg("error", ` ${config.icons.behind}${state.behind}`);
	return str;
}

export function renderFooter(
	state: FooterRenderState,
	config: PolishedTuiConfig,
	cwd: string,
	theme: Theme,
	width: number,
	options: { minimal?: boolean } = {},
): string[] {
	const dim = (s: string) => theme.fg("dim", s);
	const sep = ` ${dim(">")} `;

	const cwdLabel = theme.fg("accent", formatCwdLabel(cwd, config.icons.cwd));
	const branchLabel = renderBranchSegment(theme, state, config);
	const runtimeLabel = renderRuntimeSegment(theme, state.runtime);

	const locationVariants: string[] = [];
	if (cwdLabel && branchLabel && runtimeLabel) {
		locationVariants.push([cwdLabel, branchLabel, runtimeLabel].join(sep));
	}
	if (cwdLabel && branchLabel) locationVariants.push([cwdLabel, branchLabel].join(sep));
	if (cwdLabel) locationVariants.push(cwdLabel);
	if (branchLabel) locationVariants.push(branchLabel);
	const locationBlock = locationVariants.length > 0 ? fitFooterSegment(width, locationVariants) : "";

	const plainModelStr = theme.fg("muted", state.modelLabel);
	const modelStr =
		state.thinkingLevel && state.thinkingLevel !== "off"
			? plainModelStr + sep + theme.fg("accent", state.thinkingLevel)
			: plainModelStr;
	const modelBlock = fitFooterSegment(width, modelStr === plainModelStr ? [plainModelStr] : [modelStr, plainModelStr]);

	const ctxBlock = fitFooterSegment(width, [
		renderContextGauge(state, theme, {
			barWidth: CTX_GAUGE_WIDTH,
			includeCounts: true,
		}),
		renderContextGauge(state, theme, { barWidth: 10, includeCounts: false }),
		renderContextGauge(state, theme, { barWidth: 8, includeCounts: false }),
		renderContextGauge(state, theme, { barWidth: 6, includeCounts: false }),
		renderContextGauge(state, theme, { barWidth: 4, includeCounts: false }),
	]);

	const rightParts: string[] = [];
	if (state.hasTokens) rightParts.push(theme.fg("muted", state.tokenLabel));
	if (state.hasCost) rightParts.push(theme.fg("success", state.costLabel));
	const rightBlock = rightParts.join(" ");
	const rightWidth = visibleWidth(rightBlock);

	if (options.minimal) {
		const minimal = wrapFooterSegments([modelBlock, ctxBlock], width, sep)[0] ?? modelBlock;
		return [truncateToWidth(minimal, width)];
	}

	const lines = wrapFooterSegments([locationBlock, modelBlock, ctxBlock], width, sep);

	if (rightBlock) {
		const lastIdx = lines.length - 1;
		const lastLine = lines[lastIdx] ?? "";
		const lastWidth = visibleWidth(lastLine);

		if (lines.length > 0 && lastWidth + 1 + rightWidth <= width) {
			lines[lastIdx] = lastLine + " ".repeat(width - lastWidth - rightWidth) + rightBlock;
		} else {
			lines.push(" ".repeat(Math.max(0, width - rightWidth)) + rightBlock);
		}
	}

	if (state.usageLines?.length) {
		lines.push(...state.usageLines);
	} else {
		lines.push(truncateToWidth(theme.fg("accent", state.providerLabel), width));
	}

	return lines.map((line) => truncateToWidth(line, width));
}
