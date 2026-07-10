/**
 * default-agents.ts — Load bundled default agent configurations from markdown.
 */

import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAgentMarkdown } from "./custom-agents.js";
import type { AgentConfig } from "./types.js";

const DEFAULT_AGENT_FILES = ["general-purpose.md", "Explore.md", "Plan.md"];

function loadBundledDefaults(): Map<string, AgentConfig> {
	const dir = join(dirname(fileURLToPath(import.meta.url)), "default-agents");
	const agents = new Map<string, AgentConfig>();
	for (const file of DEFAULT_AGENT_FILES) {
		const name = basename(file, ".md");
		const content = readFileSync(join(dir, file), "utf8");
		agents.set(name, parseAgentMarkdown(name, content, "default"));
	}
	return agents;
}

export const DEFAULT_AGENTS: Map<string, AgentConfig> = loadBundledDefaults();
