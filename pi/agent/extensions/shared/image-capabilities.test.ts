import { expect, test } from "bun:test";
import { imageProtocolForTerminal, isRmuxSession } from "./image-capabilities";

test("Bootty uses the Kitty graphics protocol", () => {
	expect(imageProtocolForTerminal("xterm-bootty")).toBe("kitty");
});

test("rmux sessions do not use tmux capability probes", () => {
	expect(isRmuxSession("/private/tmp/rmux-501/bootty-0.9.1,53519,3")).toBe(true);
	expect(isRmuxSession("/private/tmp/tmux-501/default,53519,3")).toBe(false);
});
