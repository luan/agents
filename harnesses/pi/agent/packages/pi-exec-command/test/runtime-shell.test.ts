import { expect, test } from "bun:test";
import { createExecShellResolver } from "../src/runtime-shell.ts";

function resolver(
	platform: NodeJS.Platform,
	variables: Readonly<Record<string, string | undefined>>,
	existing: readonly string[],
) {
	const paths = new Set(existing);
	return createExecShellResolver({ platform, variables, exists: (path) => paths.has(path) });
}

test("selects a platform fallback without reading the host process", () => {
	const resolveMac = resolver("darwin", { SHELL: "/opt/homebrew/bin/fish" }, ["/bin/zsh", "/bin/sh"]);
	const resolveLinux = resolver("linux", {}, ["/bin/bash", "/bin/sh"]);

	expect(resolveMac()).toBe("/bin/zsh");
	expect(resolveMac("fish")).toBe("/bin/zsh");
	expect(resolveLinux()).toBe("/bin/bash");
	expect(resolveLinux("/custom/bin/zsh")).toBe("/custom/bin/zsh");
});

test("translates POSIX paths inside the selected Git for Windows installation", () => {
	const bash = "D:\\Apps\\Git\\bin\\bash.exe";
	const zsh = "D:\\Apps\\Git\\usr\\bin\\zsh.exe";
	const resolveWindows = resolver("win32", { ProgramFiles: "D:\\Apps" }, [bash, zsh]);

	expect(resolveWindows()).toBe(bash);
	expect(resolveWindows("/usr/bin/zsh")).toBe(zsh);
});
