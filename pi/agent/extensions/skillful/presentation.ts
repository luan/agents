import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, type Component } from "@earendil-works/pi-tui";
import { renderCompactSummaryLine } from "../shared/compact-summary.ts";
import { registerExtensionMessageRenderer, textComponent } from "../shared/tui";
import { darkerCardBackgroundAnsi } from "../shared/tui/card";
import { paintAnsiBackgroundRow } from "../shared/tui/text";
import { isSkillfulLoadDetails, SKILLFUL_CUSTOM_TYPE, type SkillfulLoadDetails } from "./skills";

type SkillfulTheme = {
	fg(role: string, text: string): string;
	bg(role: string, text: string): string;
	bold(text: string): string;
};

function displayPath(filePath: string): string {
	const home = homedir();
	return filePath === home ? "~" : filePath.startsWith(`${home}/`) ? `~/${filePath.slice(home.length + 1)}` : filePath;
}

function halfBackground(line: string, glyph: "▄" | "▀", width: number): string {
	const background = line.match(/\x1b\[48(?:;[0-9]+)*m/)?.[0];
	return background ? `${background.replace("[48", "[38")}${glyph.repeat(width)}\x1b[39m` : line;
}

class SkillLoadComponent implements Component {
	constructor(
		private readonly box: Box,
		private readonly theme: SkillfulTheme,
	) {}

	render(width: number): string[] {
		const background =
			darkerCardBackgroundAnsi(this.theme, "toolPendingBg") ?? this.theme.bg("toolPendingBg", " ").split(" ")[0];
		const lines = this.box.render(width).map((line) => paintAnsiBackgroundRow(line, width, background));
		if (lines.length >= 2) {
			lines[0] = halfBackground(lines[0]!, "▄", width);
			lines[lines.length - 1] = halfBackground(lines.at(-1)!, "▀", width);
		}
		return lines;
	}

	invalidate(): void {
		this.box.invalidate();
	}
}

function renderSkillLoad(details: SkillfulLoadDetails | undefined, theme: SkillfulTheme): Component {
	const name = details?.name ?? "unknown";
	const path = details?.filePath ? displayPath(details.filePath) : `${details?.loads?.length ?? 0} skill files`;
	const tokens = details?.tokens ?? details?.loads?.reduce((total, load) => total + (load.tokens ?? 0), 0) ?? 0;
	const tokenLabel = tokens > 0 ? `${tokens.toLocaleString()} tokens` : (details?.status ?? "read");
	const box = new Box(1, 1, (text) => text);
	box.addChild(
		textComponent(
			renderCompactSummaryLine(theme, {
				icon: "",
				label: "skill",
				name,
				path,
				meta: tokenLabel,
				pathUrl: details?.filePath ? pathToFileURL(details.filePath).href : undefined,
			}),
		),
	);
	return new SkillLoadComponent(box, theme);
}

export function registerSkillfulPresentation(pi: ExtensionAPI): void {
	registerExtensionMessageRenderer(pi, SKILLFUL_CUSTOM_TYPE, (message, _options, theme) => {
		const details = isSkillfulLoadDetails(message.details) ? message.details : undefined;
		return renderSkillLoad(details, theme);
	});
}
