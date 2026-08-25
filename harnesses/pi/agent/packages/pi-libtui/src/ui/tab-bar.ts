import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export interface Tab {
	id: string;
	label: string;
}

export class TabBar implements Component {
	private activeIndex: number;
	onChange?: (tab: Tab, index: number) => void;

	constructor(
		private readonly tabs: readonly Tab[],
		private readonly theme: Theme,
		initialIndex = 0,
	) {
		this.activeIndex = Math.max(0, Math.min(initialIndex, tabs.length - 1));
	}

	handleInput(data: string): boolean {
		if (matchesKey(data, "right") || data === "l") {
			this.select((this.activeIndex + 1) % this.tabs.length);
			return true;
		}
		if (matchesKey(data, "left") || data === "h") {
			this.select((this.activeIndex - 1 + this.tabs.length) % this.tabs.length);
			return true;
		}
		return false;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const chunks = this.tabs.map((tab, index) => {
			const label = ` ${tab.label} `;
			return index === this.activeIndex
				? this.theme.bg("selectedBg", this.theme.fg("accent", label))
				: `\x1b[49m${this.theme.fg("muted", label)}\x1b[49m`;
		});
		return [`\x1b[49m${truncateToWidth(chunks.join("  "), width, "")}\x1b[49m`];
	}

	private select(index: number): void {
		if (this.tabs.length === 0 || index === this.activeIndex) return;
		this.activeIndex = index;
		const tab = this.tabs[index];
		if (tab) this.onChange?.(tab, index);
	}
}
