import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCopyModeKeybindings, matchCopyModeAction } from "../src/config/keybindings.ts";

test("loads only configured modal actions", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-copy-mode-"));
	const path = join(directory, "keybindings.json");
	writeFileSync(
		path,
		JSON.stringify({
			"copy-mode.up": ["w"],
			"copy-mode.down": [],
			"copy-mode.copy": ["x", "not+a+key"],
		}),
	);
	const bindings = loadCopyModeKeybindings(path);
	expect(bindings["copy-mode.up"]).toEqual(["w"]);
	expect(bindings["copy-mode.down"]).toEqual([]);
	expect(bindings["copy-mode.left"]).toEqual([]);
	expect(bindings["copy-mode.copy"]).toEqual(["x"]);
	expect(bindings["copy-mode.foldPrefix"]).toEqual([]);
	expect(bindings["copy-mode.foldOpenAll"]).toEqual([]);
	expect(matchCopyModeAction("w", bindings)).toBe("copy-mode.up");
	expect(matchCopyModeAction("k", bindings)).toBeUndefined();
});

test("missing documents do not invent package-owned bindings", () => {
	const bindings = loadCopyModeKeybindings("/path/that/does/not/exist");
	expect(bindings["copy-mode.foldPrefix"]).toEqual([]);
	expect(bindings["copy-mode.foldClose"]).toEqual([]);
	expect(bindings["copy-mode.up"]).toEqual([]);
});
