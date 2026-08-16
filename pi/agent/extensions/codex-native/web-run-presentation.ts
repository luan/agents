import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { textComponent } from "../shared/tui";
import { summarizeWebRunCommand } from "./web-run";

export function createWebRunPresentation() {
	return {
		renderCall(args: unknown, theme: Theme, context: { isPartial?: boolean } | undefined) {
			const running = context?.isPartial !== false;
			const marker = theme.fg(running ? "dim" : "success", "•");
			const label = theme.bold(running ? "Web running" : "Web ran");
			const summary = theme.fg("muted", summarizeWebRunCommand(args));
			return textComponent(`${marker} ${label} ${summary}`);
		},
		renderResult(
			result: { content: Array<{ type: string; text?: string }> },
			{ expanded }: { expanded: boolean },
			theme: Theme,
		) {
			if (!expanded) return new Container();
			const text = result.content.find((item: { type: string }) => item.type === "text")?.text ?? "(no output)";
			return textComponent(theme.fg("dim", text));
		},
	};
}
