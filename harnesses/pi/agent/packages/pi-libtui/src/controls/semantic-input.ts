import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth } from "@earendil-works/pi-tui";
import { markInputCursor } from "../cursor.ts";
import type { TuiMouseEvent } from "../mouse.ts";
import { tuiTheme } from "../color/theme.ts";

/** Pi's single-line input with libtui's semantic insertion cursor. */
export class SemanticInput extends Input {
	/** Optional inline-field focus request; embedding surfaces retain focus ownership. */
	onFocus?: () => void;
	/** Hint displayed only while the field is empty and unfocused. */
	placeholder = "";
	private renderedWidth = 0;

	/** Focus an inline field through the shared component mouse host. */
	onMouse(event: TuiMouseEvent): boolean {
		if (!this.onFocus || event.row !== 0 || event.col < 0 || event.col >= this.renderedWidth) return false;
		if (event.type === "press" && event.button === 0) this.onFocus();
		return event.type === "press" || event.type === "release";
	}
	/**
	 * Create a Pi single-line input with a semantic insertion cursor.
	 * @param theme Active Pi theme used to derive cursor colors.
	 */
	constructor(private readonly theme: Theme) {
		super();
	}

	/**
	 * Render the native input and replace its cursor marker with the configured semantic cursor.
	 * @param width Available width in terminal cells.
	 * @returns Rendered input rows with the insertion cursor applied.
	 */
	override render(width: number): string[] {
		this.renderedWidth = Math.max(0, width);
		if (this.placeholder && !this.focused && !this.getValue()) {
			return [tuiTheme(this.theme).fg("text.secondary", truncateToWidth(`> ${this.placeholder}`, width, ""))];
		}
		return super.render(width).map((line) => markInputCursor(line, { theme: this.theme, role: "insertion" }));
	}
}
