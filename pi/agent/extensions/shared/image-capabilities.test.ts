import { expect, test } from "bun:test";
import { imageProtocolForTerminal } from "./image-capabilities";

test("Bootty uses the Kitty graphics protocol", () => {
	expect(imageProtocolForTerminal("xterm-bootty")).toBe("kitty");
});
