import { findDollarSkillReferences } from "./skills";

const SLASH_SKILL_RE = /(?<!\w)\/skill:([a-zA-Z][\w-]*)/g;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const HL = (s: string) => `\x1b[36m${s}\x1b[39m`;

export function colorize(text: string, skills: Set<string>): string {
	if (!text.includes("$") && !text.includes("/skill:")) return text;
	ANSI_RE.lastIndex = 0;
	const ranges: Array<{ start: number; end: number; text: string }> = [];
	let match = ANSI_RE.exec(text);
	while (match !== null) {
		ranges.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
		match = ANSI_RE.exec(text);
	}
	if (ranges.length === 0) return colorizePlain(text, skills);

	let out = "";
	let pos = 0;
	let isDefaultForeground = true;
	for (const range of ranges) {
		if (range.start > pos) {
			const segment = text.slice(pos, range.start);
			out += isDefaultForeground ? colorizePlain(segment, skills) : segment;
		}
		out += range.text;
		const foreground = ansiForeground(range.text);
		if (foreground) isDefaultForeground = foreground === "default";
		pos = range.end;
	}
	if (pos < text.length) {
		const segment = text.slice(pos);
		out += isDefaultForeground ? colorizePlain(segment, skills) : segment;
	}
	return out;
}

export function colorizeLines(lines: string[], skills: Set<string>): string[] {
	return colorize(lines.join("\n"), skills).split("\n");
}

export function colorizePlain(text: string, skills: Set<string>): string {
	let out = "";
	let pos = 0;
	for (const reference of findDollarSkillReferences(text, skills)) {
		out += text.slice(pos, reference.start);
		out += HL(text.slice(reference.start, reference.end));
		pos = reference.end;
	}
	out += text.slice(pos);
	return out.replace(SLASH_SKILL_RE, (match, name: string) => (skills.has(name) ? HL(`/skill:${name}`) : match));
}

function ansiForeground(sequence: string): "default" | "styled" | undefined {
	const body = sequence.slice(2, -1);
	const params = body.length === 0 ? [0] : body.split(";").map((part) => Number(part || "0"));
	for (let index = 0; index < params.length; index += 1) {
		const param = params[index];
		if (param === 0 || param === 39) return "default";
		if ((param >= 30 && param <= 37) || (param >= 90 && param <= 97)) return "styled";
		if (param === 38) return "styled";
	}
	return undefined;
}
