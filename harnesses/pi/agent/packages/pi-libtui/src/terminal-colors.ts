import type { TUI } from "@earendil-works/pi-tui";
import { type RgbColor, rgb, yiqLuminance } from "./color/palette.ts";
import { bumpTuiRenderEpoch } from "./render-epoch.ts";

type TerminalColorScheme = "dark" | "light";
type IndexedPaletteKind = "generated" | "custom" | "unknown";

/** Color facts measured from the active terminal, without theme policy. */
export interface MeasuredTerminalColors {
	readonly defaultForeground?: RgbColor;
	readonly defaultBackground?: RgbColor;
	readonly ansiBase16?: readonly RgbColor[];
	readonly indexedPalette: IndexedPaletteKind;
	readonly scheme: TerminalColorScheme;
}

export interface TerminalColorsRegistry {
	current(): MeasuredTerminalColors | undefined;
	publish(measurements: MeasuredTerminalColors | undefined): void;
	subscribe(listener: () => void): () => void;
}

const REGISTRY_TAG = "pi-libtui/terminal-colors/v3";
const REGISTRY_KEY = Symbol.for(REGISTRY_TAG);
const COLOR_RESPONSE = /^\x1b\](10|4;(\d+));(?:rgb:)?([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)(?:\x07|\x1b\\)$/iu;
const COLOR_RESPONSE_START = /^\x1b\](?:10|4;\d+);/u;
const DA1_RESPONSE = /^\x1b\[\?[0-9;]*c/u;

// type-boundary: Symbol.for slots may come from another installed libtui realm; these validators narrow it once.
type UntrustedRegistryValue = unknown;

interface SharedTerminalColorsRegistry extends TerminalColorsRegistry {
	readonly tag: typeof REGISTRY_TAG;
	readonly version: 3;
}

interface TerminalProbeBatch {
	readonly responses: readonly TerminalColorReply[];
	readonly residual: string;
	readonly pending: string;
	readonly sawDa1: boolean;
	readonly handled: boolean;
}

type TerminalColorReply =
	| { name: "foreground" | "color16" | "color231"; color: RgbColor }
	| { name: "palette"; index: number; color: RgbColor };

/** Measure terminal defaults and palette anchors while preserving unrelated input. */
export async function measureTerminalColors(tui: TUI, timeoutMs = 100): Promise<MeasuredTerminalColors> {
	const replies = new Map<string, RgbColor>();
	let pending = "";
	let sawDa1 = false;
	let finish: (() => void) | undefined;
	const completed = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const removeListener = tui.addInputListener((data) => {
		const batch = parseTerminalProbeBatch(`${pending}${data}`);
		pending = batch.pending;
		for (const response of batch.responses) {
			const key = response.name === "palette" ? `palette:${response.index}` : response.name;
			replies.set(key, response.color);
		}
		sawDa1 ||= batch.sawDa1;
		if (replies.size === 19 || sawDa1) finish?.();
		if (!batch.handled) return undefined;
		return batch.residual.length > 0 ? { data: batch.residual } : { consume: true };
	});
	const backgroundPromise = tui.queryTerminalBackgroundColor({ timeoutMs });
	const schemePromise = tui.queryTerminalColorScheme({ timeoutMs });
	const base16Queries = Array.from({ length: 16 }, (_, index) => `\x1b]4;${index};?\x1b\\`).join("");
	tui.terminal.write(`\x1b]10;?\x1b\\${base16Queries}\x1b]4;16;?\x1b\\\x1b]4;231;?\x1b\\\x1b[c`);
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		completed,
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, timeoutMs);
		}),
	]);
	if (timer) clearTimeout(timer);
	if (sawDa1) {
		removeListener();
	} else {
		const quarantine = setTimeout(removeListener, timeoutMs);
		quarantine.unref?.();
	}
	const [backgroundValue, reportedScheme] = await Promise.all([backgroundPromise, schemePromise]);
	const defaultBackground = backgroundValue ? rgb(backgroundValue.r, backgroundValue.g, backgroundValue.b) : undefined;
	const defaultForeground = replies.get("foreground");
	const indexed16 = replies.get("color16");
	const indexed231 = replies.get("color231");
	const base16 = Array.from({ length: 16 }, (_, index) => replies.get(`palette:${index}`));
	const ansiBase16 = base16.every((color): color is RgbColor => color !== undefined)
		? Object.freeze(base16)
		: undefined;
	const scheme = reportedScheme ?? inferScheme(defaultBackground, defaultForeground);
	const indexedPalette =
		indexed16 === undefined || indexed231 === undefined
			? "unknown"
			: defaultBackground === undefined || defaultForeground === undefined
				? "custom"
				: matchesTerminalColor(indexed16, defaultBackground) && matchesTerminalColor(indexed231, defaultForeground)
					? "generated"
					: "custom";
	return Object.freeze({
		defaultForeground,
		defaultBackground,
		ansiBase16,
		indexedPalette,
		scheme,
	});
}

function parseTerminalColorReply(data: string): TerminalColorReply | undefined {
	const match = COLOR_RESPONSE.exec(data);
	if (!match) return undefined;
	const color = rgb(channel(match[3]!), channel(match[4]!), channel(match[5]!));
	if (match[1] === "10") return { name: "foreground", color };
	const index = Number(match[2]);
	if (index === 16) return { name: "color16", color };
	if (index === 231) return { name: "color231", color };
	return { name: "palette", index, color };
}

/** Return the process-wide measured-color store shared by duplicate package realms. */
export function terminalColorsRegistry(scope: typeof globalThis = globalThis): TerminalColorsRegistry {
	const slots = scope as Record<PropertyKey, UntrustedRegistryValue>;
	const existing = slots[REGISTRY_KEY];
	if (isRegistry(existing)) return existing;

	let current: MeasuredTerminalColors | undefined;
	const listeners = new Set<() => void>();
	const registry: SharedTerminalColorsRegistry = {
		tag: REGISTRY_TAG,
		version: 3,
		current: () => current,
		publish(measurements) {
			if (measurements !== undefined && !isMeasurements(measurements)) {
				throw new TypeError("Invalid pi-libtui terminal color measurements");
			}
			const next = measurements ? freezeMeasurements(measurements) : undefined;
			if (sameMeasurements(current, next)) return;
			current = next;
			bumpTuiRenderEpoch();
			for (const listener of [...listeners]) {
				try {
					listener();
				} catch {
					/* Subscribers only request a render. */
				}
			}
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	slots[REGISTRY_KEY] = registry;
	return registry;
}

function sameMeasurements(
	left: MeasuredTerminalColors | undefined,
	right: MeasuredTerminalColors | undefined,
): boolean {
	if (left === right) return true;
	if (!left || !right) return false;
	if (
		left.indexedPalette !== right.indexedPalette ||
		left.scheme !== right.scheme ||
		!sameRgb(left.defaultForeground, right.defaultForeground) ||
		!sameRgb(left.defaultBackground, right.defaultBackground)
	)
		return false;
	if (left.ansiBase16?.length !== right.ansiBase16?.length) return false;
	return left.ansiBase16?.every((color, index) => sameRgb(color, right.ansiBase16?.[index])) ?? true;
}

function sameRgb(left: RgbColor | undefined, right: RgbColor | undefined): boolean {
	return (
		left === right ||
		(left !== undefined && right !== undefined && left.r === right.r && left.g === right.g && left.b === right.b)
	);
}

function parseTerminalProbeBatch(data: string): TerminalProbeBatch {
	const responses: TerminalColorReply[] = [];
	let residual = "";
	let pending = "";
	let sawDa1 = false;
	let handled = false;
	let offset = 0;

	while (offset < data.length) {
		const escapeIndex = data.indexOf("\x1b", offset);
		if (escapeIndex < 0) {
			residual += data.slice(offset);
			break;
		}
		residual += data.slice(offset, escapeIndex);
		const fragment = data.slice(escapeIndex);
		const colorStart = COLOR_RESPONSE_START.exec(fragment);
		if (colorStart) {
			const terminator = colorResponseTerminator(fragment, colorStart[0].length);
			if (terminator === undefined) {
				pending = fragment;
				handled = true;
				break;
			}
			const frame = fragment.slice(0, terminator);
			const response = parseTerminalColorReply(frame);
			if (response) responses.push(response);
			offset = escapeIndex + frame.length;
			handled = true;
			continue;
		}
		if (isPotentialColorResponse(fragment)) {
			pending = fragment;
			handled = true;
			break;
		}
		const da1 = DA1_RESPONSE.exec(fragment);
		if (da1) {
			offset = escapeIndex + da1[0].length;
			sawDa1 = true;
			handled = true;
			continue;
		}
		if (isPotentialDa1Response(fragment)) {
			pending = fragment;
			handled = true;
			break;
		}
		residual += "\x1b";
		offset = escapeIndex + 1;
	}

	return { responses, residual, pending, sawDa1, handled };
}

function colorResponseTerminator(data: string, from: number): number | undefined {
	for (let index = from; index < data.length; index += 1) {
		if (data[index] === "\x07") return index + 1;
		if (data[index] === "\x1b" && data[index + 1] === "\\") return index + 2;
	}
	return undefined;
}

function isPotentialColorResponse(data: string): boolean {
	if (!data.startsWith("\x1b]")) return false;
	const body = data.slice(2);
	if ("10;".startsWith(body) || "4;".startsWith(body)) return true;
	if (!body.startsWith("4;")) return false;
	return /^4;\d*;?$/u.test(body);
}

function isPotentialDa1Response(data: string): boolean {
	return /^\x1b\[\?[0-9;]*$/u.test(data);
}

function channel(value: string): number {
	if (value.length === 1) return Number.parseInt(value.repeat(2), 16);
	if (value.length === 2) return Number.parseInt(value, 16);
	const maximum = 16 ** value.length - 1;
	return (Number.parseInt(value, 16) * 255) / maximum;
}

function inferScheme(background: RgbColor | undefined, foreground: RgbColor | undefined): TerminalColorScheme {
	if (!background) return "dark";
	const backgroundLuminance = yiqLuminance(background);
	return foreground && backgroundLuminance > yiqLuminance(foreground)
		? "light"
		: backgroundLuminance > 127
			? "light"
			: "dark";
}

function isRegistry(value: UntrustedRegistryValue): value is SharedTerminalColorsRegistry {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<SharedTerminalColorsRegistry>;
	return (
		candidate.tag === REGISTRY_TAG &&
		candidate.version === 3 &&
		typeof candidate.current === "function" &&
		typeof candidate.publish === "function" &&
		typeof candidate.subscribe === "function"
	);
}

function isRgbColor(value: UntrustedRegistryValue): value is RgbColor {
	if (!value || typeof value !== "object") return false;
	const color = value as Partial<RgbColor>;
	return [color.r, color.g, color.b].every(
		(channelValue) =>
			typeof channelValue === "number" && Number.isInteger(channelValue) && channelValue >= 0 && channelValue <= 255,
	);
}

function isMeasurements(value: UntrustedRegistryValue): value is MeasuredTerminalColors {
	if (!value || typeof value !== "object") return false;
	const measurements = value as Partial<MeasuredTerminalColors>;
	return (
		(measurements.scheme === "dark" || measurements.scheme === "light") &&
		(measurements.indexedPalette === "generated" ||
			measurements.indexedPalette === "custom" ||
			measurements.indexedPalette === "unknown") &&
		(measurements.defaultForeground === undefined || isRgbColor(measurements.defaultForeground)) &&
		(measurements.defaultBackground === undefined || isRgbColor(measurements.defaultBackground)) &&
		(measurements.ansiBase16 === undefined ||
			(Array.isArray(measurements.ansiBase16) &&
				measurements.ansiBase16.length === 16 &&
				measurements.ansiBase16.every(isRgbColor)))
	);
}

function freezeMeasurements(measurements: MeasuredTerminalColors): MeasuredTerminalColors {
	return Object.freeze({
		...measurements,
		defaultForeground: measurements.defaultForeground
			? rgb(measurements.defaultForeground.r, measurements.defaultForeground.g, measurements.defaultForeground.b)
			: undefined,
		defaultBackground: measurements.defaultBackground
			? rgb(measurements.defaultBackground.r, measurements.defaultBackground.g, measurements.defaultBackground.b)
			: undefined,
		ansiBase16: measurements.ansiBase16
			? Object.freeze(measurements.ansiBase16.map(({ r, g, b }) => rgb(r, g, b)))
			: undefined,
	});
}

function matchesTerminalColor(left: RgbColor, right: RgbColor): boolean {
	return Math.abs(left.r - right.r) <= 2 && Math.abs(left.g - right.g) <= 2 && Math.abs(left.b - right.b) <= 2;
}
