import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CustomEditor, UserMessageComponent } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider } from "@mariozechner/pi-tui";

const SKILL_PREFIX = "skill:";
const DOLLAR_RE = /(?<![\w$])\$([a-zA-Z][\w-]*)/g;
const SLASH_SKILL_RE = /(?<!\w)\/skill:([a-zA-Z][\w-]*)/g;
const MENTION_AT_CURSOR_RE = /(?:^|\s)\$([a-zA-Z0-9\-_]*)$/;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const HL = (s: string) => `\x1b[36m${s}\x1b[39m`;

const AUTOCOMPLETE_INSTALLED = Symbol.for("skill-dollar.autocompleteInstalled");
const INPUT_TRIGGER_PATCHED = Symbol.for("skill-dollar.inputTriggerPatched");
const RENDER_WRAPPED = Symbol.for("skill-dollar.userMessageWrapped");

function isPrintable(data: string): boolean {
	return data.length === 1 && data.charCodeAt(0) >= 32;
}

function findMentionAtCursor(line: string, col: number): { token: string; query: string } | null {
	const m = line.slice(0, col).match(MENTION_AT_CURSOR_RE);
	if (!m) return null;
	return { token: `$${m[1]}`, query: m[1] };
}

function collectSkills(pi: ExtensionAPI): Map<string, string> {
	const out = new Map<string, string>();
	for (const cmd of pi.getCommands()) {
		if (cmd.source !== "skill" || !cmd.name.startsWith(SKILL_PREFIX)) continue;
		const name = cmd.name.slice(SKILL_PREFIX.length).trim();
		const path = cmd.sourceInfo?.path;
		if (!name || !path || out.has(name)) continue;
		out.set(name, path);
	}
	return out;
}

function buildItems(skills: Map<string, string>): AutocompleteItem[] {
	return [...skills.keys()].map((n) => ({
		value: `$${n}`,
		label: `$${n}`,
		description: "skill",
	}));
}

function wrapProvider(base: AutocompleteProvider, getItems: () => AutocompleteItem[]): AutocompleteProvider {
	const wrapped: AutocompleteProvider = {
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const mention = findMentionAtCursor(lines[cursorLine] ?? "", cursorCol);
			if (mention) {
				const q = mention.query.toLowerCase();
				const items = getItems().filter((i) => q === "" || i.label.toLowerCase().includes(q));
				if (items.length > 0) return { items, prefix: mention.token };
				return null;
			}
			return base.getSuggestions(lines, cursorLine, cursorCol, options);
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (prefix.startsWith("$")) {
				const line = lines[cursorLine] ?? "";
				const start = cursorCol - prefix.length;
				const next = [...lines];
				next[cursorLine] = line.slice(0, start) + item.value + line.slice(cursorCol);
				return {
					lines: next,
					cursorLine,
					cursorCol: start + item.value.length,
				};
			}
			return base.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
	};
	if (typeof base.shouldTriggerFileCompletion === "function") {
		wrapped.shouldTriggerFileCompletion = base.shouldTriggerFileCompletion.bind(base);
	}
	return wrapped;
}

function patchDollarAutocompleteTrigger() {
	const proto = CustomEditor.prototype as unknown as {
		handleInput: (data: string) => void;
		[INPUT_TRIGGER_PATCHED]?: true;
	};
	if (proto[INPUT_TRIGGER_PATCHED]) return;
	proto[INPUT_TRIGGER_PATCHED] = true;
	const original = proto.handleInput;
	proto.handleInput = function (this: Record<string, unknown>, data: string) {
		original.call(this, data);
		const showing = this.isShowingAutocomplete as (() => boolean) | undefined;
		if (showing?.call(this)) return;
		if (!isPrintable(data)) return;
		const getLines = this.getLines as (() => string[]) | undefined;
		const getCursor = this.getCursor as (() => { line: number; col: number }) | undefined;
		const trigger = this.tryTriggerAutocomplete as (() => void) | undefined;
		if (!getLines || !getCursor || !trigger) return;
		const cursor = getCursor.call(this);
		const lines = getLines.call(this);
		if (findMentionAtCursor(lines[cursor.line] ?? "", cursor.col)) {
			trigger.call(this);
		}
	};
}

export default function (pi: ExtensionAPI) {
	patchDollarAutocompleteTrigger();

	let skills: Map<string, string> = new Map();
	let items: AutocompleteItem[] = [];

	const refresh = () => {
		skills = collectSkills(pi);
		items = buildItems(skills);
	};
	const currentItems = () => {
		refresh();
		return items;
	};

	// Idempotently wrap UserMessageComponent.prototype.render so $skill / /skill:name
	// in submitted messages get cyan-highlighted in the transcript. The tui extension
	// also patches this prototype and runs after us, so we have to (re)apply our
	// wrap whenever its render replaces ours.
	const ensureTranscriptHighlight = () => {
		const proto = UserMessageComponent.prototype as unknown as {
			render: (width: number) => string[];
		} & { [RENDER_WRAPPED]?: typeof proto.render };
		const current = proto.render;
		if (proto[RENDER_WRAPPED] === current) return;
		const known = () => new Set(skills.keys());
		const wrapped = function (this: UserMessageComponent, width: number): string[] {
			const out = current.call(this, width);
			if (!Array.isArray(out)) return out;
			const set = known();
			return out.map((line) => colorize(line, set));
		};
		proto.render = wrapped;
		proto[RENDER_WRAPPED] = wrapped;
	};

	pi.on("resources_discover", () => {
		refresh();
	});

	// Inject referenced skill bodies into the system prompt for this turn,
	// keeping the literal $name in the user message so the transcript shows
	// what the user typed.
	pi.on("before_agent_start", async (event) => {
		refresh();
		// Re-apply transcript highlight in case another extension repatched
		// the prototype after we did.
		ensureTranscriptHighlight();

		const referenced = new Map<string, string>();
		for (const m of event.prompt.matchAll(DOLLAR_RE)) {
			const name = m[1];
			const path = skills.get(name);
			if (path && !referenced.has(name)) referenced.set(name, path);
		}
		if (referenced.size === 0) return;

		const blocks: string[] = [];
		for (const [name, path] of referenced) {
			try {
				const body = stripFrontmatter(await readFile(path, "utf8"));
				blocks.push(`<skill name="${name}" path="${path}">\n${body}\n</skill>`);
			} catch {
				// Skill file missing or unreadable — skip silently rather than
				// failing the turn.
			}
		}
		if (blocks.length === 0) return;

		const injection = `\n\n<referenced_skills>\nThe user referenced these skills with $name. Use their guidance for this turn.\n\n${blocks.join("\n\n")}\n</referenced_skills>`;
		return { systemPrompt: event.systemPrompt + injection };
	});

	pi.on("session_start", async (_event, ctx) => {
		refresh();
		// Defer past the end of the session_start tick so tui (which runs
		// after us alphabetically) has a chance to install its own
		// UserMessageComponent.render patch first; then we wrap on top of it.
		setTimeout(() => {
			refresh();
			ensureTranscriptHighlight();
		}, 0);
		if (!ctx.hasUI) return;
		const ui = ctx.ui as typeof ctx.ui & { [AUTOCOMPLETE_INSTALLED]?: true };
		if (ui[AUTOCOMPLETE_INSTALLED]) return;
		ui[AUTOCOMPLETE_INSTALLED] = true;
		ctx.ui.addAutocompleteProvider((current) => wrapProvider(current, currentItems));
	});
}

// Split on ANSI escapes and colorize only plain segments so we don't fight the
// background/rail decoration that UserMessageComponent's render bakes into
// the output.
function colorize(line: string, skills: Set<string>): string {
	if (!line.includes("$") && !line.includes("/skill:")) return line;
	ANSI_RE.lastIndex = 0;
	const ranges: Array<{ start: number; end: number; text: string }> = [];
	let m = ANSI_RE.exec(line);
	while (m !== null) {
		ranges.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
		m = ANSI_RE.exec(line);
	}
	if (ranges.length === 0) return colorizePlain(line, skills);
	let out = "";
	let pos = 0;
	for (const r of ranges) {
		if (r.start > pos) out += colorizePlain(line.slice(pos, r.start), skills);
		out += r.text;
		pos = r.end;
	}
	if (pos < line.length) out += colorizePlain(line.slice(pos), skills);
	return out;
}

function colorizePlain(text: string, skills: Set<string>): string {
	return text
		.replace(DOLLAR_RE, (m, name: string) => (skills.has(name) ? HL(`$${name}`) : m))
		.replace(SLASH_SKILL_RE, (m, name: string) => (skills.has(name) ? HL(`/skill:${name}`) : m));
}

// Strip a leading YAML frontmatter block (--- ... ---) so the skill body is
// what gets injected, not the metadata pi already consumed.
function stripFrontmatter(text: string): string {
	if (!text.startsWith("---")) return text;
	const end = text.indexOf("\n---", 3);
	if (end === -1) return text;
	const after = text.indexOf("\n", end + 4);
	return after === -1 ? "" : text.slice(after + 1);
}
