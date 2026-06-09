import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";

const MENTION_AT_CURSOR_RE = /(?:^|\s)\$([a-zA-Z0-9\-_]*)$/;

type TriggeredAutocompleteProvider = AutocompleteProvider & {
	triggerCharacters?: string[];
};

export function findMentionAtCursor(line: string, col: number): { token: string; query: string } | null {
	const match = line.slice(0, col).match(MENTION_AT_CURSOR_RE);
	if (!match) return null;
	return { token: `$${match[1]}`, query: match[1] };
}

export function wrapProvider(base: AutocompleteProvider, getItems: () => AutocompleteItem[]): AutocompleteProvider {
	const wrapped: TriggeredAutocompleteProvider = {
		triggerCharacters: ["$"],
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const mention = findMentionAtCursor(lines[cursorLine] ?? "", cursorCol);
			if (mention) {
				const query = mention.query.toLowerCase();
				const items = getItems().filter((item) => query === "" || item.label.toLowerCase().includes(query));
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
