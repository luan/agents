import { expect, test } from "bun:test";
import { filterExtensionsByPath } from "./agent-runner";

test("filters subagent extensions by configured path", () => {
	const extensions = [
		{ path: "extensions/fileops/index.ts", resolvedPath: "/agent/extensions/fileops/index.ts" },
		{ path: "extensions/exec-command/index.ts", resolvedPath: "/agent/extensions/exec-command/index.ts" },
		{ path: "extensions/codex-native/index.ts", resolvedPath: "/agent/extensions/codex-native/index.ts" },
	];

	expect(
		filterExtensionsByPath(extensions, ["extensions/fileops/index.ts", "extensions/codex-native/index.ts"]),
	).toEqual([extensions[0], extensions[2]]);
});
