import { expect, test } from "bun:test";
import { sanitizeTuiAnsiChunk, sanitizeTuiFieldPreview, sanitizeTuiTextPreview } from "../src/content/terminal-text.ts";

test("sanitizes split SGR and OSC sequences only after their boundary arrives", () => {
	const sgrStart = sanitizeTuiAnsiChunk("before\x1b[3");
	const sgrEnd = sanitizeTuiAnsiChunk(`${sgrStart.pending}1mred`);
	const oscStart = sanitizeTuiAnsiChunk("before\x1b]52;c;secret");
	const oscEnd = sanitizeTuiAnsiChunk(`${oscStart.pending}\x1b\\after`);

	expect(sgrStart.text).toBe("before");
	expect(sgrEnd.text).toBe("\x1b[31mred");
	expect(oscStart.text).toBe("before");
	expect(oscEnd.text).toBe("after");
});

test("bounds display previews without splitting Unicode or terminal controls", () => {
	expect(sanitizeTuiTextPreview("a🙂b", 2)).toBe("a…");
	expect(sanitizeTuiTextPreview("a🙂b", 3)).toBe("a🙂…");
	expect(sanitizeTuiTextPreview("before\x1b]52;c;secret", 12)).toBe("before…");
	expect(sanitizeTuiFieldPreview("one\ntwo\tthree", 7)).toBe("one two…");
});
