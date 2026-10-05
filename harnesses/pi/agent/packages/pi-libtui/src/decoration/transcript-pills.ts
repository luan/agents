import type { Theme } from "@earendil-works/pi-coding-agent";
import { hyperlink, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { tuiTheme } from "../color/theme.ts";
import { type PillContent, renderPillText } from "./glyphs.ts";
import { contrastingPillBackground, renderPill } from "./powerline-pill.ts";

/** Paint transcript pills before native Markdown, selection, and overlay composition. */
export function renderTranscriptPill(
	theme: Theme,
	content: PillContent,
	width: number,
	muted = false,
	options: { surface: "assistant"; href?: string } | { surface: "user" } = { surface: "user" },
): string {
	const clean = stripTerminalSequences(content.label).replace(/[\r\n\t]/g, " ");
	const padding = visibleWidth(renderPillText({ ...content, label: "" }));
	const label = stripTerminalSequences(truncateToWidth(clean, Math.max(1, width - padding - 1), "…"));
	const destination = muted || options.surface === "assistant" ? "\x1b[49m" : theme.getBgAnsi("userMessageBg");
	const colors = tuiTheme(theme);
	const contrast = contrastingPillBackground(theme, destination);
	const background = colors.mixForeground(colors.contrastBackground(contrast), contrast, 0.2);
	const following = muted
		? theme.getFgAnsi("dim")
		: options.surface === "user"
			? theme.getFgAnsi("userMessageText")
			: colors.fgAnsi("text.primary");
	// Pi wraps at ASCII spaces; keep the painted pill together.
	const pill = renderPill(
		theme,
		{
			...content,
			label,
			...(muted ? { iconTone: "text.muted" as const } : {}),
		},
		background,
		muted ? "text.muted" : "text.primary",
		undefined,
		destination,
	).replaceAll(" ", "\u00a0");
	if (options.surface === "user") return pill + following;
	const linked = options.href ? hyperlink(pill, options.href.replaceAll("|", "%7C")) : pill;
	// Code spans keep titles and link metadata out of Pi's math/link tokenizers.
	const delimiter = "`".repeat(
		(linked.match(/`+/g) ?? []).reduce((length, run) => Math.max(length, run.length), 0) + 1,
	);
	return `${delimiter}${linked}${delimiter}${following}`;
}
