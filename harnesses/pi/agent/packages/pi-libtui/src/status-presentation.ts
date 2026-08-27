import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	getTuiAppearance,
	type TuiStatusPresentationStyle,
	type TuiAnimationSpeed,
	type TuiRequestPhase,
} from "./appearance.ts";
import type { TuiForegroundColor, TuiHue, TuiTheme } from "./color/theme.ts";
import { animationSpeedMultiplier } from "./motion.ts";

/** Render one intentional full status-row animation. */
export function statusPresentationFrame(
	colors: TuiTheme,
	style: TuiStatusPresentationStyle,
	elapsedMs: number,
	width: number,
	options: { animationSpeed?: TuiAnimationSpeed; phase?: TuiRequestPhase; reducedMotion?: boolean } = {},
): string {
	if (style === "standard") return "";
	const boundedWidth = Math.max(10, Math.min(120, Math.floor(width)));
	const scaledElapsed = options.reducedMotion
		? 0
		: Math.max(0, elapsedMs) * animationSpeedMultiplier(options.animationSpeed ?? getTuiAppearance().animationSpeed);
	const frame = scaledElapsed / 60;
	const phase = options.phase ?? "working";
	const rendered = renderStatusPresentation(colors, style, frame, boundedWidth, phase);
	return visibleWidth(rendered) <= boundedWidth ? rendered : truncateToWidth(rendered, boundedWidth, "");
}

/** Produce message text for inline presentations that replace only the ordinary phase label. */
export function activityMessageFrame(
	elapsedMs: number,
	options: { animationSpeed?: TuiAnimationSpeed; reducedMotion?: boolean } = {},
): string {
	const scaledElapsed = options.reducedMotion
		? 0
		: Math.max(0, elapsedMs) * animationSpeedMultiplier(options.animationSpeed ?? getTuiAppearance().animationSpeed);
	const { shown, cursor } = typewriterParts(scaledElapsed / 60);
	return `${shown}${cursor}`;
}

function renderStatusPresentation(
	colors: TuiTheme,
	style: Exclude<TuiStatusPresentationStyle, "standard">,
	frame: number,
	width: number,
	phase: TuiRequestPhase,
): string {
	switch (style) {
		case "neural-pulse":
			return neuralPulse(colors, frame, width);
		case "plasma-wave":
			return plasmaWave(colors, frame, width);
		case "pacman":
			return pacman(colors, frame, width);
		case "matrix":
			return matrix(colors, frame, width);
		case "pipeline":
			return pipeline(colors, frame);
		case "starfield":
			return starfield(colors, frame, width);
		case "fire":
			return fire(colors, frame, width);
		case "icon-morph":
			return iconMorph(colors, frame);
		case "brainstorm":
			return brainstorm(colors, frame);
		case "dev-constellation":
			return devConstellation(colors, frame);
		case "pi-pulse":
			return piPulse(colors, frame);
		case "orbit-dots":
			return orbitDots(colors, frame, phase);
		case "neon-bounce":
			return neonBounce(colors, frame, width);
		case "block-wave":
			return blockWave(colors, frame, width);
		case "conveyor":
			return conveyor(colors, frame, width);
		case "accordion":
			return accordion(colors, frame, width);
	}
}

function neuralPulse(colors: TuiTheme, frame: number, width: number): string {
	const nodes = Math.max(3, Math.min(14, Math.floor(width / 4)));
	let output = "";
	for (let index = 0; index < nodes; index += 1) {
		const distance = positiveModulo(index - frame * 0.5, nodes);
		output += colors.fg(neuralTone(distance), distance < 7 ? "●" : "○");
		if (index < nodes - 1) {
			const connectorDistance = positiveModulo(index + 0.5 - frame * 0.5, nodes);
			output += colors.fg(neuralTone(connectorDistance), "──");
		}
	}
	return output;
}

function neuralTone(distance: number): TuiForegroundColor {
	if (distance >= 7) return "text.muted";
	const hues: readonly TuiHue[] = ["blue", "blue", "magenta", "magenta", "magenta", "blue", "blue"];
	const shades = [2, 3, 4, 5, 4, 3, 2] as const;
	const index = Math.floor(distance);
	return { hue: hues[index] ?? "blue", shade: shades[index] ?? 2 };
}

function plasmaWave(colors: TuiTheme, frame: number, width: number): string {
	const glyphs = [" ", "·", "∘", "○", "◎", "●", "◉", "█"] as const;
	const hues: readonly TuiHue[] = ["magenta", "blue", "cyan", "green", "yellow", "red"];
	return Array.from({ length: width }, (_, index) => {
		const wave =
			(Math.sin(index * 0.15 + frame * 0.08) +
				Math.sin(index * 0.1 + frame * 0.06) +
				Math.sin(Math.abs(index) * 0.15 + frame * 0.1)) /
			3;
		const level = Math.max(0, Math.min(glyphs.length - 1, Math.round(((wave + 1) / 2) * (glyphs.length - 1))));
		return colors.fg(
			{ hue: hues[(index + Math.floor(frame / 2)) % hues.length] ?? "blue", shade: level > 4 ? 5 : 3 },
			glyphs[level]!,
		);
	}).join("");
}

function pacman(colors: TuiTheme, frame: number, width: number): string {
	const size = Math.min(40, width);
	const course = size + 8;
	const head = Math.floor(frame) % course;
	const ghost = (Math.floor(frame) - 4 + course) % course;
	return Array.from({ length: size }, (_, index) => {
		if (head < size && index === head) return colors.fg("warning", Math.floor(frame) % 4 < 2 ? "ᗧ" : "●");
		if (ghost < size && index === ghost) return colors.fg({ hue: "red", shade: 5 }, "ᗣ");
		if (head >= size || index > head)
			return colors.fg(index % 8 === 0 ? "text.primary" : { hue: "yellow", shade: 3 }, index % 8 === 0 ? "●" : "·");
		return " ";
	}).join("");
}

const MATRIX_CHARACTERS = "ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘ012789Z";

function matrix(colors: TuiTheme, frame: number, width: number): string {
	const cells = Array.from({ length: width }, () => " ");
	for (let seed = 0; seed < Math.max(15, Math.floor(width * 0.4)); seed += 1) {
		const speed = 0.3 + deterministicUnit(seed, 9) * 0.5;
		const position = Math.floor((frame * speed + deterministicUnit(seed, 4) * 100) % (width + 5));
		for (let trail = 0; trail < 3; trail += 1) {
			const index = position - trail;
			if (index < 0 || index >= width || cells[index] !== " ") continue;
			const glyph = MATRIX_CHARACTERS[(seed + trail + Math.floor(frame)) % MATRIX_CHARACTERS.length]!;
			cells[index] = colors.fg({ hue: "green", shade: (5 - trail) as 3 | 4 | 5 }, glyph);
		}
	}
	return cells.join("");
}

const PIPELINE_ICONS = ["\uf0e7", "\uf013", "\uf121", "\uf0ad", "\uf00c"] as const;

function pipeline(colors: TuiTheme, frame: number): string {
	const gap = 5;
	const total = PIPELINE_ICONS.length * (gap + 1) + 1;
	const pulse = (frame * 0.4) % total;
	return PIPELINE_ICONS.map((glyph, index) => {
		const start = index * (gap + 1);
		const active = pulse >= start && pulse < start + gap + 1;
		const icon = colors.fg(
			{ hue: ["yellow", "blue", "green", "red", "cyan"][index] as TuiHue, shade: active ? 5 : 2 },
			`${glyph} `,
		);
		if (index === PIPELINE_ICONS.length - 1) return icon;
		const track = Array.from({ length: gap }, (_, offset) => {
			const position = start + 1 + offset;
			return colors.fg(
				Math.abs(pulse - position) < 1.5 ? "text.primary" : pulse > position ? "accent" : "text.muted",
				Math.abs(pulse - position) < 1.5 ? "═" : "─",
			);
		}).join("");
		return `${icon}${track}`;
	}).join("");
}

function starfield(colors: TuiTheme, frame: number, width: number): string {
	const cells = Array.from({ length: width }, () => " ");
	const glyphs = ["·", "∙", "•", "✦", "★"] as const;
	for (let seed = 0; seed < Math.max(20, Math.floor(width * 0.6)); seed += 1) {
		const speed = 0.2 + deterministicUnit(seed, 3) * 1.2;
		const layer = Math.min(glyphs.length - 1, Math.floor(speed / 0.3));
		const position = Math.floor((deterministicUnit(seed, 7) * width + frame * speed) % width);
		const shade = Math.max(1, Math.min(5, layer + 1)) as 1 | 2 | 3 | 4 | 5;
		cells[position] = colors.fg({ hue: "blue", shade }, glyphs[layer]!);
	}
	return cells.join("");
}

const FIRE_GLYPHS = " .:-=+*#%@█";

function fire(colors: TuiTheme, frame: number, width: number): string {
	const frameIndex = Math.floor(frame);
	const rows = Array.from({ length: 4 }, () => new Float64Array(width));
	for (let index = 0; index < width; index += 1) {
		const fuel = deterministicUnit(index, frameIndex);
		rows[3]![index] = fuel > 0.35 ? 1 : deterministicUnit(index + width, frameIndex) * 0.5;
	}
	for (let row = 2; row >= 0; row -= 1) {
		for (let index = 0; index < width; index += 1) {
			const below = rows[row + 1]!;
			rows[row]![index] = (below[(index - 1 + width) % width]! + below[index]! + below[(index + 1) % width]!) / 3.1;
		}
	}
	return Array.from(rows[0]!, (heat) => {
		const level = Math.floor(heat * (FIRE_GLYPHS.length - 1));
		const tone =
			level > 7
				? "warning"
				: ({
						hue: level > 4 ? "yellow" : "red",
						shade: Math.max(2, Math.min(5, 2 + Math.floor(level / 3))) as 2 | 3 | 4 | 5,
					} as const);
		return colors.fg(tone, FIRE_GLYPHS[level]!);
	}).join("");
}

const MORPH_ICONS = ["\uf0eb", "\uf013", "\uf0e7", "\uf135", "\uf005", "\uf06d", "\uf0ac", "\uf004"] as const;

function iconMorph(colors: TuiTheme, frame: number): string {
	const duration = 25;
	const position =
		((frame % (MORPH_ICONS.length * duration)) + MORPH_ICONS.length * duration) % (MORPH_ICONS.length * duration);
	const index = Math.floor(position / duration);
	const progress = (position % duration) / duration;
	const transition = "░▒▓█▓▒░";
	const glyph =
		progress < 0.3
			? MORPH_ICONS[index]!
			: progress < 0.7
				? transition[Math.min(transition.length - 1, Math.floor(((progress - 0.3) / 0.4) * transition.length))]!
				: MORPH_ICONS[(index + 1) % MORPH_ICONS.length]!;
	const trail = Array.from({ length: 20 }, (_, seed) =>
		deterministicUnit(seed, Math.floor(frame)) < 0.25 ? (seed % 3 === 0 ? "✦" : "·") : " ",
	).join("");
	return `${colors.fg({ hue: ["yellow", "blue", "magenta", "cyan"][index % 4] as TuiHue, shade: 5 }, glyph)}  ${colors.fg("warning", trail)}`;
}

const BRAINSTORM_PHASES = [
	["\ue30d", "calm"],
	["\ue302", "thinking."],
	["\ue318", "thinking.."],
	["\ue31d", "EUREKA!"],
	["\ue30b", "insight!"],
	["\ue302", "processing"],
] as const;

function brainstorm(colors: TuiTheme, frame: number): string {
	const state = BRAINSTORM_PHASES[Math.floor(frame / 35) % BRAINSTORM_PHASES.length]!;
	const pulseShade = Math.max(2, Math.min(5, Math.round(3.5 + Math.sin(frame * 0.15) * 1.5))) as 2 | 3 | 4 | 5;
	const sparks = Array.from({ length: 15 }, (_, seed) =>
		deterministicUnit(seed, Math.floor(frame)) < 0.15 ? (seed % 3 === 0 ? "⚡" : "✦") : " ",
	).join("");
	return `\x1b[1m${colors.fg({ hue: "yellow", shade: pulseShade }, `${state[0]}  ${state[1]}`)}\x1b[22m ${colors.fg("accent", sparks)}`;
}

const DEV_ICONS = ["\ue796", "\ue718", "\ue73c", "\ue7a8", "\uf13b", "\ue61e"] as const;

function devConstellation(colors: TuiTheme, frame: number): string {
	const gap = 5;
	const pulse = (frame * 0.4) % (DEV_ICONS.length * (gap + 1) - 1);
	return DEV_ICONS.map((glyph, index) => {
		const node = index * (gap + 1);
		const icon = colors.fg(
			{
				hue: ["blue", "green", "yellow", "magenta", "cyan", "red"][index] as TuiHue,
				shade: Math.abs(pulse - node) < 1.5 ? 5 : 3,
			},
			glyph,
		);
		if (index === DEV_ICONS.length - 1) return icon;
		return `${icon}${Array.from({ length: gap }, (_, offset) => colors.fg(Math.abs(pulse - (node + 1 + offset)) < 1 ? "text.primary" : "text.muted", Math.abs(pulse - (node + 1 + offset)) < 2.5 ? "─" : "·")).join("")}`;
	}).join("");
}

function piPulse(colors: TuiTheme, frame: number): string {
	const hue = ["magenta", "blue", "cyan"][Math.floor(frame * 0.3) % 3] as TuiHue;
	const trailGlyphs = "·∘○◎●";
	const trail = Array.from({ length: 20 }, (_, index) => {
		const level = Math.floor(((Math.sin((index / 20) * Math.PI * 2 + frame * 0.1) + 1) / 2) * (trailGlyphs.length - 1));
		return colors.fg({ hue, shade: Math.max(2, 5 - Math.floor(index / 7)) as 2 | 3 | 4 | 5 }, trailGlyphs[level]!);
	}).join("");
	return `${colors.fg({ hue, shade: 5 }, "\ue22c")}  ${trail}`;
}

const TYPEWRITER_MESSAGES = [
	"Engaging warp drive...",
	"Running diagnostics...",
	"Recalibrating sensors...",
	"Scanning the horizon...",
	"Channeling the cosmos...",
	"Weaving neural threads...",
	"Parsing the matrix...",
] as const;

function typewriterParts(frame: number): { shown: string; cursor: string } {
	const cycle = TYPEWRITER_MESSAGES.reduce((total, message) => total + message.length + 30, 0);
	let position = positiveModulo(Math.floor(frame), cycle);
	let message: (typeof TYPEWRITER_MESSAGES)[number] = TYPEWRITER_MESSAGES[0]!;
	for (const candidate of TYPEWRITER_MESSAGES) {
		const duration = candidate.length + 30;
		if (position < duration) {
			message = candidate;
			break;
		}
		position -= duration;
	}
	const progress = Math.min(message.length, position + 1);
	const shown = message.slice(0, Math.min(message.length, progress));
	const cursor = progress < message.length ? ["✦", "✧", "⚡", "★", "·"][Math.floor(frame) % 5]! : "";
	return { shown, cursor };
}

function orbitDots(colors: TuiTheme, frame: number, phase: TuiRequestPhase): string {
	const glyphs = ["·", "∘", "○", "●", "◉", "●", "○", "∘"] as const;
	const dots = Array.from({ length: 5 }, (_, index) => {
		const norm = (Math.sin(frame * 0.12 - index * 0.8) + 1) / 2;
		const glyph = glyphs[Math.floor(norm * (glyphs.length - 1))]!;
		return colors.fg(
			{
				hue: ["magenta", "blue", "cyan"][Math.floor(index + frame * 0.1) % 3] as TuiHue,
				shade: Math.max(2, Math.min(5, Math.round(2 + norm * 3))) as 2 | 3 | 4 | 5,
			},
			`${norm > 0.7 ? `\x1b[1m${glyph}\x1b[22m` : glyph} `,
		);
	}).join("");
	return `${dots}  ${colors.fg("accent", phaseLabel(phase))}${colors.fg("text.secondary", ellipsis(frame))}`;
}

function neonBounce(colors: TuiTheme, frame: number, width: number): string {
	const size = Math.max(1, width - 2);
	const cycle = (frame * 0.6) % (size * 2);
	const head = Math.floor(cycle < size ? cycle : size * 2 - cycle);
	const cells = Array.from({ length: size }, () => " ");
	for (let age = 4; age >= 0; age -= 1) {
		const priorCycle = ((((frame - age) * 0.6) % (size * 2)) + size * 2) % (size * 2);
		const position = Math.floor(priorCycle < size ? priorCycle : size * 2 - priorCycle);
		if (position >= 0 && position < size)
			cells[position] = colors.fg(
				{ hue: "magenta", shade: Math.max(1, 5 - age) as 1 | 2 | 3 | 4 | 5 },
				["█", "▓", "▒", "░", "·"][age]!,
			);
	}
	if (head >= 0 && head < size) cells[head] = colors.fg("accent", "█");
	return `${colors.fg("text.muted", "▐")}${cells.join("")}${colors.fg("text.muted", "▌")}`;
}

function blockWave(colors: TuiTheme, frame: number, width: number): string {
	const size = Math.max(10, Math.min(28, width));
	const half = (size - 1) / 2;
	const sweep = (frame * 0.22) % (half * 2);
	const head = sweep <= half ? sweep : half * 2 - sweep;
	return Array.from({ length: size }, (_, index) => {
		const distance = Math.min(Math.abs(index - head), Math.abs(index - (size - 1 - head)));
		const glyph = distance < 0.6 ? "█" : distance < 1.3 ? "▓" : distance < 2.2 ? "▒" : "·";
		return colors.fg(distance < 2.2 ? "accent" : "text.muted", glyph);
	}).join("");
}

function conveyor(colors: TuiTheme, frame: number, width: number): string {
	const size = Math.max(10, Math.min(32, width));
	const head = (Math.floor(frame * 0.45) % (size + 4)) - 2;
	return blockTrack(colors, size, [
		{ position: head - 2, glyph: "▒" },
		{ position: head - 1, glyph: "▓" },
		{ position: head, glyph: "█" },
	]);
}

function accordion(colors: TuiTheme, frame: number, width: number): string {
	const size = Math.max(10, Math.min(32, width));
	return blockTrack(colors, size, [
		{ position: accordionPosition(frame - 8, size), glyph: "▒" },
		{ position: accordionPosition(frame - 4, size), glyph: "▓" },
		{ position: accordionPosition(frame, size), glyph: "█" },
	]);
}

function accordionPosition(frame: number, width: number): number {
	const phase = ((((frame % 90) + 90) % 90) / 90) * Math.PI * 2;
	return ((1 - Math.cos(phase)) / 2) * (width - 1);
}

function blockTrack(colors: TuiTheme, width: number, blocks: readonly { position: number; glyph: string }[]): string {
	const cells = Array.from({ length: width }, () => colors.fg("text.muted", "░"));
	for (const block of blocks) {
		const position = Math.round(block.position);
		if (position >= 0 && position < width) cells[position] = colors.fg("accent", block.glyph);
	}
	return cells.join("");
}

function positiveModulo(value: number, modulus: number): number {
	return ((value % modulus) + modulus) % modulus;
}

function phaseLabel(phase: TuiRequestPhase): string {
	return phase === "thinking" ? "Thinking" : phase === "tool" ? "Running" : "Working";
}

function ellipsis(frame: number): string {
	return [".", "..", "...", ""][Math.floor(frame / 10) % 4]!;
}

function deterministicUnit(seed: number, frame: number): number {
	const value = Math.sin(seed * 12.9898 + frame * 78.233) * 43_758.5453;
	return value - Math.floor(value);
}
