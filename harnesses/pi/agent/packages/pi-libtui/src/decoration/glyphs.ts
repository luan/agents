import type { Theme } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { getTuiAppearance, type TuiIconPack } from "../appearance.ts";
import { type TuiBackgroundToken, type TuiColor, type TuiForegroundColor, tuiTheme } from "../color/theme.ts";

/** Every semantic icon token supported by all pi-libtui icon packs. */
export const TUI_ICON_NAMES = [
	"settings",
	"appearance",
	"ux",
	"animations",
	"behavior",
	"interaction",
	"tools",
	"toggle-on",
	"toggle-off",
	"checkbox-on",
	"checkbox-off",
	"comment",
	"reaction",
	"copy",
	"paste",
	"edit",
	"delete",
	"reset",
	"close",
	"cancel",
	"confirm",
	"search",
	"submit",
	"warning",
	"error",
	"lightbulb",
	"developer",
	"user",
	"code-mode",
	"view-image",
	"expand-closed",
	"expand-open",
	"fold-closed",
	"fold-open",
	"fold-unfold",
	"fold-down",
	"fold-up",
	"fold",
	"diff-hunk",
] as const;

/** A semantic icon role resolved through the active icon pack. */
export type TuiIconName = (typeof TUI_ICON_NAMES)[number];

/** Icon-bearing content accepted by every shared pill renderer. */
export interface PillContent {
	/** Semantic icon, a deliberate custom glyph, or an explicit iconless opt-out. */
	icon: TuiIconName | { readonly glyph: string } | false;
	/** Text shown after the icon. */
	label: string;
	/** Optional semantic icon tone; defaults to the pill foreground. */
	iconTone?: TuiForegroundColor;
}

const ICONS: Record<TuiIconPack, Record<TuiIconName, string>> = {
	"nerd-fonts": {
		settings: "",
		appearance: "󰃣",
		ux: "󰮄",
		animations: "",
		behavior: "󰚩",
		interaction: "󰌌",
		tools: "",
		"toggle-on": "",
		"toggle-off": "",
		"checkbox-on": "󰱒",
		"checkbox-off": "󰄱",
		comment: "",
		reaction: "",
		copy: "",
		paste: "󰆒",
		edit: "",
		delete: "",
		reset: "",
		close: "󰿅",
		cancel: "󰜺",
		confirm: "",
		search: "",
		submit: "",
		warning: "",
		error: "",
		lightbulb: "",
		developer: "󱔘",
		user: "󰷈",
		"code-mode": "",
		"view-image": "",
		"expand-closed": "",
		"expand-open": "",
		"fold-closed": "",
		"fold-open": "",
		"fold-unfold": "",
		"fold-down": "",
		"fold-up": "",
		fold: "",
		"diff-hunk": "",
	},
	unicode: {
		settings: "⚙",
		appearance: "✦",
		ux: "●",
		animations: "↺",
		behavior: "⚗",
		interaction: "⌨",
		tools: "⚒",
		"toggle-on": "●",
		"toggle-off": "○",
		"checkbox-on": "☑",
		"checkbox-off": "☐",
		comment: "✎",
		reaction: "☺",
		copy: "⧉",
		paste: "⇲",
		edit: "✎",
		delete: "×",
		reset: "↺",
		close: "×",
		cancel: "×",
		confirm: "✓",
		search: "⌕",
		submit: "➤",
		warning: "⚠",
		error: "×",
		lightbulb: "💡",
		developer: "◆",
		user: "●",
		"code-mode": "⌘",
		"view-image": "▣",
		"expand-closed": "›",
		"expand-open": "⌄",
		"fold-closed": "›",
		"fold-open": "⌄",
		"fold-unfold": "↕",
		"fold-down": "⌄",
		"fold-up": "⌃",
		fold: "•",
		"diff-hunk": "≋",
	},
	emoji: {
		settings: "⚙️",
		appearance: "🎨",
		ux: "👤",
		animations: "🔄",
		behavior: "🤖",
		interaction: "⌨️",
		tools: "🛠️",
		"toggle-on": "✅",
		"toggle-off": "⭕",
		"checkbox-on": "☑️",
		"checkbox-off": "⬜",
		comment: "💬",
		reaction: "🙂",
		copy: "📋",
		paste: "📥",
		edit: "📝",
		delete: "🗑️",
		reset: "🔄",
		close: "❌",
		cancel: "❌",
		confirm: "✅",
		search: "🔍",
		submit: "📤",
		warning: "⚠️",
		error: "❌",
		lightbulb: "💡",
		developer: "🛠️",
		user: "👤",
		"code-mode": "⌘",
		"view-image": "🖼️",
		"expand-closed": "›",
		"expand-open": "⌄",
		"fold-closed": "›",
		"fold-open": "⌄",
		"fold-unfold": "↕",
		"fold-down": "⌄",
		"fold-up": "⌃",
		fold: "•",
		"diff-hunk": "≋",
	},
};

/**
 * Resolve a semantic icon through the active Unicode, Nerd Font, or emoji pack.
 * @param name Semantic icon role.
 * @returns The glyph owned by the active icon pack.
 */
export function icon(name: TuiIconName): string {
	return ICONS[getTuiAppearance().iconPack][name];
}

/**
 * Resolve the left and right pill caps for a requested shape.
 * @param powerline Whether to use Powerline caps; defaults to the active appearance setting.
 * @returns A readonly `[left, right]` separator pair.
 */
export function getTuiPillSeparators(powerline = getTuiAppearance().powerline): readonly [string, string] {
	return powerline ? ["", ""] : ["▐", "▌"];
}

/**
 * Render a label without terminal color state, using the configured pill shape.
 * @param content Required icon decision and plain or already-styled label content.
 * @returns The label surrounded by the active pill separators.
 */
export function renderPillText(content: PillContent): string {
	const [left, right] = getTuiPillSeparators();
	const glyph = pillIcon(content.icon);
	return `${left}${glyph ? `${glyph} ` : ""}${content.label}${right}`;
}

/** Resolve a semantic or custom pill icon. */
export function pillIcon(value: PillContent["icon"]): string {
	if (value === false) return "";
	return typeof value === "string" ? icon(value) : value.glyph;
}

/** Glyph family supported by reusable key hints. */
export type TuiKeyIconPack = "nerd-fonts" | "unicode";

const MODIFIER_ORDER = ["ctrl", "super", "alt", "shift"] as const;
const MODIFIERS: Record<TuiKeyIconPack, Record<(typeof MODIFIER_ORDER)[number], string>> = {
	"nerd-fonts": { ctrl: "󰘴", super: "󰘳", alt: "󰘵", shift: "󰘶" },
	unicode: { ctrl: "⌃", super: "⌘", alt: "⌥", shift: "⇧" },
};
const NAMED_KEYS: Record<TuiKeyIconPack, Record<string, string>> = {
	"nerd-fonts": {
		space: "󱁐",
		tab: "󰌒",
		enter: "󰌑",
		return: "󰌑",
		backspace: "󰁮",
		escape: "⎋",
		esc: "⎋",
	},
	unicode: {
		space: "␣",
		tab: "⇥",
		enter: "⏎",
		return: "⏎",
		backspace: "⌫",
		escape: "⎋",
		esc: "⎋",
	},
};
const KEYCAP_BACKGROUND = "badge.neutral" as const;

function activePack(): TuiKeyIconPack {
	return getTuiAppearance().iconPack === "nerd-fonts" ? "nerd-fonts" : "unicode";
}

function letterIcon(letter: string, pack: TuiKeyIconPack): string {
	const index = letter.codePointAt(0)! - "a".codePointAt(0)!;
	return pack === "nerd-fonts" ? String.fromCodePoint(0xf0b08 + index) : String.fromCodePoint(0x1f170 + index);
}

/**
 * Render a key identifier as compact reusable modifier and key glyphs.
 * Unsupported bases remain literal instead of inventing a misleading icon.
 * @param key Pi key identifier such as `ctrl+c`, `space`, or `escape`.
 * @param pack Optional glyph family; defaults to Nerd Fonts only when the active appearance uses them.
 * @returns An unstyled key-hint string.
 */
export function keyIcon(key: KeyId, pack: TuiKeyIconPack = activePack()): string {
	const parts = key.split("+");
	const base = parts.pop() ?? key;
	const modifiers = MODIFIER_ORDER.filter((modifier) => parts.includes(modifier)).map(
		(modifier) => MODIFIERS[pack][modifier],
	);
	const normalized = base.toLowerCase();
	const baseIcon = /^[a-z]$/u.test(normalized) ? letterIcon(normalized, pack) : (NAMED_KEYS[pack][normalized] ?? base);
	return [...modifiers, baseIcon].join(" ");
}

/**
 * Render a key identifier as a subdued semantic keycap adapted to its destination background.
 * @param theme Active Pi theme used for semantic coloring.
 * @param key Pi key identifier to render.
 * @param pack Optional explicit key glyph family.
 * @param background Optional destination background restored after the keycap.
 * @returns ANSI-styled key hint.
 */
export function renderKeyHint(
	theme: Theme,
	key: KeyId,
	pack?: TuiKeyIconPack,
	background?: TuiBackgroundToken | TuiColor,
): string {
	const colors = tuiTheme(theme);
	const keycapBackground = colors.color(KEYCAP_BACKGROUND);
	const keycapForeground = colors.contrastBackground(keycapBackground);
	const resolvedPack = pack ?? activePack();
	const glyph = textPresentation(keyIcon(key, resolvedPack), resolvedPack);
	const keycap = colors.bg(keycapBackground, colors.fg(keycapForeground, glyph));
	return `${keycap}${destinationBackgroundAnsi(colors, background)}`;
}

function destinationBackgroundAnsi(
	colors: ReturnType<typeof tuiTheme>,
	background: TuiBackgroundToken | TuiColor | undefined,
): string {
	if (background === undefined) return "\x1b[49m";
	return colors.bgAnsi(background);
}

function textPresentation(glyph: string, pack: TuiKeyIconPack | undefined): string {
	if (pack !== "unicode") return glyph;
	return glyph.replace(/[🄰-🅉🅰-🆉]/gu, (letter) => `${letter}\uFE0E`);
}
