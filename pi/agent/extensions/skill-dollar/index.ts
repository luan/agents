import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { patchDollarAutocompleteTrigger, wrapProvider } from "./autocomplete";
import { installEditorHighlight } from "./editor";
import {
	buildItems,
	collectSkills,
	rewriteDollarSkillCommand,
	rewriteSlashSkillReferences,
	stripFrontmatter,
} from "./skills";
import { ensureTranscriptHighlight } from "./transcript";

const DOLLAR_RE = /(?<![\w$])\$([a-zA-Z][\w-]*)/g;
const AUTOCOMPLETE_INSTALLED = Symbol.for("skill-dollar.autocompleteInstalled");

type SkillState = {
	skills: Map<string, string>;
	items: AutocompleteItem[];
};

export default function (pi: ExtensionAPI) {
	patchDollarAutocompleteTrigger();

	const state: SkillState = { skills: new Map(), items: [] };
	const refresh = () => {
		state.skills = collectSkills(pi);
		state.items = buildItems(state.skills);
	};
	const skillNames = () => new Set(state.skills.keys());
	const currentItems = () => {
		refresh();
		return state.items;
	};

	pi.on("resources_discover", () => {
		refresh();
	});

	pi.on("input", (event) => {
		refresh();
		const text = rewriteDollarSkillCommand(event.text, state.skills.keys());
		if (text === event.text) return { action: "continue" };
		return { action: "transform", text };
	});

	pi.on("before_agent_start", async (event) => {
		refresh();
		ensureTranscriptHighlight(skillNames);

		const referenced = new Map<string, string>();
		for (const match of event.prompt.matchAll(DOLLAR_RE)) {
			const name = match[1];
			const path = state.skills.get(name);
			if (path && !referenced.has(name)) referenced.set(name, path);
		}
		if (referenced.size === 0) return;

		const blocks: string[] = [];
		for (const [name, path] of referenced) {
			try {
				const body = rewriteSlashSkillReferences(
					stripFrontmatter(await readFile(path, "utf8")),
					state.skills.keys(),
				);
				blocks.push(`<skill name="${name}" path="${path}">\n${body}\n</skill>`);
			} catch {
				// Skills can be removed between discovery and prompt handling.
			}
		}
		if (blocks.length === 0) return;

		const injection = `\n\n<referenced_skills>\nThe user referenced these skills with $name. Use their guidance for this turn.\n\n${blocks.join("\n\n")}\n</referenced_skills>`;
		return { systemPrompt: event.systemPrompt + injection };
	});

	pi.on("session_start", async (event, ctx) => {
		refresh();
		setTimeout(() => {
			try {
				refresh();
				ensureTranscriptHighlight(skillNames);
				if (ctx.hasUI) installEditorHighlight(ctx.ui, skillNames);
			} catch (error) {
				if (!(error instanceof Error) || !error.message.includes("ctx is stale")) throw error;
			}
		}, 0);
		if (!ctx.hasUI) return;
		const ui = ctx.ui as typeof ctx.ui & { [AUTOCOMPLETE_INSTALLED]?: true };
		if (ui[AUTOCOMPLETE_INSTALLED] && event.reason !== "reload") return;
		ui[AUTOCOMPLETE_INSTALLED] = true;
		ctx.ui.addAutocompleteProvider((current) => wrapProvider(current, currentItems));
	});
}
