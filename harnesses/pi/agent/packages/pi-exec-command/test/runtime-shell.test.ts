import { expect, test } from "bun:test";
import { DEFAULT_EXEC_SHELL, resolveRuntimeShell } from "../src/runtime-shell.ts";

test("fish never becomes the exec command runtime shell", () => {
	expect(resolveRuntimeShell("/opt/homebrew/bin/fish")).toBe(DEFAULT_EXEC_SHELL);
	expect(resolveRuntimeShell("fish")).toBe(DEFAULT_EXEC_SHELL);
	expect(resolveRuntimeShell(undefined)).toBe(DEFAULT_EXEC_SHELL);
});

test("an explicitly compatible shell is preserved", () => {
	expect(resolveRuntimeShell("/custom/bin/zsh")).toBe("/custom/bin/zsh");
	expect(resolveRuntimeShell("/custom/bin/bash")).toBe("/custom/bin/bash");
});
