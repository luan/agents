import type { PromptSection } from "./report.ts";
import { estimateTokens } from "./token-estimates.ts";

/** Partition without dropping text, merging duplicate headings, or treating fenced code as headings. */
export function promptSections(prompt: string): PromptSection[] {
	const sections: PromptSection[] = [];
	let content = "";
	let label = "System prompt";
	let fence: string | undefined;
	const flush = () => {
		if (content) sections.push({ label, content, estimate: estimateTokens(content) });
		content = "";
	};
	for (const line of prompt.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
		const delimiter = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (delimiter) {
			if (!fence) fence = delimiter;
			else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = undefined;
		} else if (!fence) {
			const heading = /^#{1,6}\s+(.+?)(?:\s+#+)?\s*$/.exec(line)?.[1];
			if (heading) {
				flush();
				label = heading;
			}
		}
		content += line;
	}
	flush();
	return sections;
}
