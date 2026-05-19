import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { colorizeLines } from "./highlight";
import { extractDollarSkillReferences } from "./skills";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const RENDER_VERSION = Symbol.for("skillful.userMessageRenderVersion");
const CURRENT_RENDER_VERSION = 2;

export function ensureTranscriptHighlight(getSkillNames: () => Set<string>): void {
	const proto = UserMessageComponent.prototype as unknown as {
		render: (width: number) => string[];
	} & { [RENDER_VERSION]?: number };
	if (proto[RENDER_VERSION] === CURRENT_RENDER_VERSION) return;
	const wrapped = function (this: UserMessageComponent, width: number): string[] {
		const out = renderUserMessageBase(this, width);
		if (!Array.isArray(out)) return out;
		return highlightTranscriptLines(out, rawUserMessageText(this), getSkillNames());
	};
	proto.render = wrapped;
	proto[RENDER_VERSION] = CURRENT_RENDER_VERSION;
}

export function highlightTranscriptLines(lines: string[], rawText: string | undefined, skills: Set<string>): string[] {
	if (rawText === undefined) return colorizeLines(lines, skills);
	const referenced = extractDollarSkillReferences(rawText, skills);
	if (referenced.length === 0) return lines;
	return colorizeLines(lines, new Set(referenced));
}

function renderUserMessageBase(message: UserMessageComponent, width: number): string[] {
	const containerProto = Object.getPrototypeOf(UserMessageComponent.prototype) as {
		render: (this: UserMessageComponent, width: number) => string[];
	};
	const lines = containerProto.render.call(message, width);
	if (lines.length === 0) return lines;
	lines[0] = OSC133_ZONE_START + lines[0];
	lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
	return lines;
}

function rawUserMessageText(message: UserMessageComponent): string | undefined {
	const contentBox = (message as unknown as { contentBox?: { children?: unknown[] } }).contentBox;
	const markdown = contentBox?.children?.find(
		(child): child is { text: string } => Boolean(child) && typeof (child as { text?: unknown }).text === "string",
	);
	return markdown?.text;
}
