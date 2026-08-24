import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input } from "@earendil-works/pi-tui";
import { markInputCursor } from "../cursor.ts";

/** Pi's single-line input with libtui's semantic insertion cursor. */
export class SemanticInput extends Input {
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
		return super.render(width).map((line) => markInputCursor(line, { theme: this.theme, role: "insertion" }));
	}
}
