import { type Theme, UserMessageComponent } from "@mariozechner/pi-coding-agent";
import { Container, visibleWidth } from "@mariozechner/pi-tui";
import { ANSI_RESET, fillBackgroundLine } from "./render-lines";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const USER_MESSAGE_ORIGINAL_RENDER = Symbol.for("agents.polishedTui.userMessageOriginalRender");

type UiPatchState = { currentUiTheme?: Theme };
const globalPatchState = globalThis as typeof globalThis & {
	__agentsPolishedTuiState?: UiPatchState;
};
globalPatchState.__agentsPolishedTuiState ??= {};
const patchState = globalPatchState.__agentsPolishedTuiState;

export function setTranscriptTheme(uiTheme: Theme): void {
	patchState.currentUiTheme = uiTheme;
}

export function patchUserMessageComponent(uiTheme: Theme): void {
	setTranscriptTheme(uiTheme);

	const prototype = UserMessageComponent.prototype as unknown as {
		render(width: number): string[];
	} & Record<symbol, unknown>;
	const originalRender =
		(prototype[USER_MESSAGE_ORIGINAL_RENDER] as
			| ((this: UserMessageComponent, width: number) => string[])
			| undefined) ?? prototype.render;
	if (prototype[USER_MESSAGE_ORIGINAL_RENDER]) return;
	prototype[USER_MESSAGE_ORIGINAL_RENDER] = prototype.render;
	prototype.render = function (this: UserMessageComponent, width: number): string[] {
		const currentTheme = patchState.currentUiTheme;
		if (!currentTheme) return originalRender.call(this, width);

		const railWidth = 2;
		const innerWidth = Math.max(1, width - railWidth);
		const baseLines = Container.prototype.render.call(this, innerWidth) as string[];
		if (baseLines.length === 0) return baseLines;

		const hasLeadingSpacer = baseLines.length > 1 && visibleWidth(baseLines[0] ?? "") === 0;
		const leadingLines = hasLeadingSpacer ? [baseLines[0] ?? ""] : [];
		const contentLines = hasLeadingSpacer ? baseLines.slice(1) : baseLines;
		const rail = `${currentTheme.fg("border", "┃")}${ANSI_RESET}${currentTheme.bg("customMessageBg", " ")}`;
		const styledLines = contentLines.map((line) => `${rail}${fillBackgroundLine(currentTheme, line, innerWidth)}`);

		if (styledLines.length === 0) return leadingLines;

		styledLines[0] = OSC133_ZONE_START + styledLines[0];
		styledLines[styledLines.length - 1] += OSC133_ZONE_END + OSC133_ZONE_FINAL;
		return [...leadingLines, ...styledLines];
	};
}
