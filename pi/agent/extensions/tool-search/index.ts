// Registration stays unconditional. Tool policy makes `tool_search` Declared in code-mode and Direct when code-mode is off.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { asTomlRegisteredTool, discoverTomlTools, type TomlTool } from "../code-mode/toml-tools.ts";
import { createToolSearchDefinition } from "../code-mode/tool-search.ts";
import { toolRegistrarFor } from "../shared/tool-registry.ts";

export default function toolSearchExtension(pi: ExtensionAPI): void {
	const register = toolRegistrarFor(pi);
	const registerToml = (tool: TomlTool) => register(asTomlRegisteredTool(tool) as never);
	const registerEagerToml = (cwd: string) => {
		for (const tool of discoverTomlTools(cwd).tools) {
			if (!tool.deferLoading) registerToml(tool);
		}
	};

	registerEagerToml(process.cwd());
	register(createToolSearchDefinition(registerToml) as never);
	pi.on("session_start", (_event, ctx) => registerEagerToml(ctx.cwd));
}
