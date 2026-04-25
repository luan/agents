import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CustomEditor, UserMessageComponent } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider } from "@mariozechner/pi-tui";
import { readFile } from "node:fs/promises";

const SKILL_PREFIX = "skill:";
const DOLLAR_RE = /(?<![\w$])\$([a-zA-Z][\w-]*)/g;
const SLASH_SKILL_RE = /(?<!\w)\/skill:([a-zA-Z][\w-]*)/g;
const MENTION_AT_CURSOR_RE = /(?:^|\s)\$([a-zA-Z0-9\-_]*)$/;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const HL = (s: string) => `\x1b[36m${s}\x1b[39m`;

const ENHANCED = Symbol.for("skill-dollar.enhanced");
const PATCHED = Symbol.for("skill-dollar.uiPatched");
const RENDER_WRAPPED = Symbol.for("skill-dollar.userMessageWrapped");

function isPrintable(data: string): boolean {
	return data.length === 1 && data.charCodeAt(0) >= 32;
}

function findMentionAtCursor(
	line: string,
	col: number,
): { token: string; query: string } | null {
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

function wrapProvider(
	base: AutocompleteProvider,
	getItems: () => AutocompleteItem[],
): AutocompleteProvider {
	const wrapped: AutocompleteProvider = {
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const mention = findMentionAtCursor(lines[cursorLine] ?? "", cursorCol);
			if (mention) {
				const q = mention.query.toLowerCase();
				const items = getItems().filter(
					(i) => q === "" || i.label.toLowerCase().includes(q),
				);
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
				return { lines: next, cursorLine, cursorCol: start + item.value.length };
			}
			return base.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
	};
	if (typeof base.shouldTriggerFileCompletion === "function") {
		wrapped.shouldTriggerFileCompletion = base.shouldTriggerFileCompletion.bind(base);
	}
	return wrapped;
}

// Reassign methods on the live instance instead of subclassing, so this works
// regardless of which class the underlying editor extends (CustomEditor,
// PolishedEditor from the tui extension, etc.). Idempotent via marker symbol.
function enhance(
	editor: unknown,
	getItems: () => AutocompleteItem[],
): unknown {
	if (!editor || typeof editor !== "object") return editor;
	const e = editor as Record<PropertyKey, unknown> & { [ENHANCED]?: true };
	if (e[ENHANCED]) return editor;
	e[ENHANCED] = true;

	if (typeof e.setAutocompleteProvider === "function") {
		const orig = (e.setAutocompleteProvider as Function).bind(e);
		e.setAutocompleteProvider = (provider: AutocompleteProvider) => {
			orig(wrapProvider(provider, getItems));
		};
	}

	if (typeof e.handleInput === "function") {
		const orig = (e.handleInput as Function).bind(e);
		e.handleInput = (data: string) => {
			orig(data);
			const showing = e.isShowingAutocomplete as (() => boolean) | undefined;
			if (showing && showing.call(e)) return;
			if (!isPrintable(data)) return;
			const getLines = e.getLines as (() => string[]) | undefined;
			const getCursor = e.getCursor as (() => { line: number; col: number }) | undefined;
			if (!getLines || !getCursor) return;
			const cursor = getCursor.call(e);
			const lines = getLines.call(e);
			if (!findMentionAtCursor(lines[cursor.line] ?? "", cursor.col)) return;
			const trigger = e.tryTriggerAutocomplete as (() => void) | undefined;
			if (typeof trigger === "function") trigger.call(e);
		};
	}

	return editor;
}

export default function (pi: ExtensionAPI) {
	let skills: Map<string, string> = new Map();
	let items: AutocompleteItem[] = [];

	const refresh = () => {
		skills = collectSkills(pi);
		items = buildItems(skills);
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

		const injection =
			`\n\n<referenced_skills>\nThe user referenced these skills with $name. Use their guidance for this turn.\n\n${blocks.join("\n\n")}\n</referenced_skills>`;
		return { systemPrompt: event.systemPrompt + injection };
	});

	pi.on("session_start", async (_event, ctx) => {
		refresh();
		// Defer past the end of the session_start tick so tui (which runs
		// after us alphabetically) has a chance to install its own
		// UserMessageComponent.render patch first; then we wrap on top of it.
		setTimeout(ensureTranscriptHighlight, 0);
		if (!ctx.hasUI) return;

		// Patch setEditorComponent so any factory installed by a later extension
		// (or by us below) gets composed with skill-dollar's enhancements. This
		// is the only way to chain — the API has no getter and only the last
		// setter wins. Relies on extensions running in load order: skill-dollar
		// patches first, later extensions' factories flow through the wrapper.
		const ui = ctx.ui as unknown as Record<PropertyKey, unknown> & {
			[PATCHED]?: true;
			setEditorComponent: (factory: ((...a: unknown[]) => unknown) | undefined) => void;
		};
		if (!ui[PATCHED]) {
			ui[PATCHED] = true;
			const original = ui.setEditorComponent.bind(ui);
			ui.setEditorComponent = (factory) => {
				if (!factory) {
					original(undefined);
					return;
				}
				original((...args: unknown[]) => enhance(factory(...args), () => items));
			};
		}

		// Install a default so $-completion works even with no other editor
		// extension. Later setEditorComponent calls (e.g. tui) replace this
		// with their own editor, still flowing through the wrapper above.
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings),
		);
	});
}

// Split on ANSI escapes and colorize only plain segments so we don't fight the
// background/rail decoration that UserMessageComponent's render bakes into
// the output.
function colorize(line: string, skills: Set<string>): string {
	if (!line.includes("$") && !line.includes("/skill:")) return line;
	ANSI_RE.lastIndex = 0;
	const ranges: Array<{ start: number; end: number; text: string }> = [];
	let m: RegExpExecArray | null;
	while ((m = ANSI_RE.exec(line)) !== null) {
		ranges.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
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
		.replace(SLASH_SKILL_RE, (m, name: string) =>
			skills.has(name) ? HL(`/skill:${name}`) : m,
		);
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
