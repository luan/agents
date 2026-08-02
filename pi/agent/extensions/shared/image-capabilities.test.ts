import { expect, test } from "bun:test";
import { imageCellDimensionsForTerminal, imageProtocolForTerminal, isRmuxSession } from "./image-capabilities";

test("Bootty uses the Kitty graphics protocol", () => {
	expect(imageProtocolForTerminal("xterm-bootty")).toBe("kitty");
});

test("Bootty uses calibrated cell dimensions", () => {
	expect(imageCellDimensionsForTerminal("xterm-bootty", { widthPx: 9, heightPx: 18 })).toEqual({
		widthPx: 7,
		heightPx: 22,
	});
	expect(imageCellDimensionsForTerminal("xterm-bootty", { widthPx: 8, heightPx: 20 })).toEqual({
		widthPx: 7,
		heightPx: 22,
	});
});

test("rmux sessions do not use tmux capability probes", () => {
	expect(isRmuxSession("/private/tmp/rmux-501/bootty-0.9.1,53519,3")).toBe(true);
	expect(isRmuxSession("/private/tmp/tmux-501/default,53519,3")).toBe(false);
});
