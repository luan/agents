import { CustomEditor } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider } from "@mariozechner/pi-tui";

function extractAtPrefix(textBeforeCursor: string): string | null {
	const match = textBeforeCursor.match(/(?:^|[ \t])(@(?:"[^"]*|[^\s]*))$/);
	return match?.[1] ?? null;
}

export function buildAtCompletionValue(path: string): string {
	return path.includes(" ") ? `@"${path}"` : `@${path}`;
}

function createFffMentionProvider(
	getItems: (query: string, signal: AbortSignal) => Promise<AutocompleteItem[]>,
): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const currentLine = lines[cursorLine] || "";
			const prefix = extractAtPrefix(currentLine.slice(0, cursorCol));
			if (!prefix || options.signal.aborted) return null;

			const query = prefix.startsWith('@"') ? prefix.slice(2) : prefix.slice(1);
			const items = await getItems(query, options.signal);
			return options.signal.aborted || items.length === 0 ? null : { items, prefix };
		},
		applyCompletion(_lines, cursorLine, cursorCol, item, prefix) {
			const currentLine = _lines[cursorLine] || "";
			const before = currentLine.slice(0, cursorCol - prefix.length);
			const after = currentLine.slice(cursorCol);
			const newLine = before + item.value + after;
			const newCursorCol = cursorCol - prefix.length + item.value.length;
			return {
				lines: [..._lines.slice(0, cursorLine), newLine, ..._lines.slice(cursorLine + 1)],
				cursorLine,
				cursorCol: newCursorCol,
			};
		},
	};
}

export class FffEditor extends CustomEditor {
	private baseProvider: AutocompleteProvider | undefined;

	constructor(
		tui: any,
		theme: any,
		keybindings: any,
		private getMentionItems: (query: string, signal: AbortSignal) => Promise<AutocompleteItem[]>,
	) {
		super(tui, theme, keybindings);
	}

	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.baseProvider = provider;
		const mentionProvider = createFffMentionProvider(this.getMentionItems);
		const compositeProvider: AutocompleteProvider = {
			getSuggestions: async (lines, cursorLine, cursorCol, options) => {
				const mentionResult = await mentionProvider.getSuggestions(lines, cursorLine, cursorCol, options);
				if (mentionResult) return mentionResult;
				return this.baseProvider?.getSuggestions(lines, cursorLine, cursorCol, options) ?? null;
			},
			applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
				if (prefix?.startsWith("@")) {
					return mentionProvider.applyCompletion!(lines, cursorLine, cursorCol, item, prefix);
				}
				return (
					this.baseProvider?.applyCompletion?.(lines, cursorLine, cursorCol, item, prefix) ?? {
						lines,
						cursorLine,
						cursorCol,
					}
				);
			},
		};
		super.setAutocompleteProvider(compositeProvider);
	}
}
