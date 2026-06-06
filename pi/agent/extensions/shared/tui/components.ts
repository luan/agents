import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";

type MessageRenderer = Parameters<ExtensionAPI["registerMessageRenderer"]>[1];

export class EmptyComponent implements Component {
	render(): string[] {
		return [];
	}

	invalidate(): void {}
}

export function textComponent(text: string): Text {
	return new Text(text, 0, 0);
}

export function registerExtensionMessageRenderer(
	pi: Partial<Pick<ExtensionAPI, "registerMessageRenderer">>,
	customType: string,
	renderer: MessageRenderer,
): void {
	pi.registerMessageRenderer?.(customType, renderer);
}
