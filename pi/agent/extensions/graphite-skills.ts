import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type GraphiteConfig = {
	trunk?: string;
};

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "graphite-skills");

export default function graphiteSkills(pi: ExtensionAPI) {
	pi.on("resources_discover", () => {
		if (!graphiteSkillsActive()) return;
		return { skillPaths: [SKILLS_DIR] };
	});
}

function graphiteSkillsActive(): boolean {
	const configPath = graphiteConfigPath();
	if (!configPath) return false;
	const trunk = graphiteTrunk(configPath);
	const branch = gitOutput(["symbolic-ref", "--short", "HEAD"]);
	return Boolean(branch && branch !== trunk);
}

function graphiteConfigPath(): string | undefined {
	const gitDir = gitOutput(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (!gitDir) return undefined;
	const path = join(gitDir, ".graphite_repo_config");
	return existsSync(path) ? path : undefined;
}

function graphiteTrunk(configPath: string): string {
	try {
		const config = JSON.parse(readFileSync(configPath, "utf8")) as GraphiteConfig;
		return config.trunk || "main";
	} catch {
		return "main";
	}
}

function gitOutput(args: string[]): string | undefined {
	try {
		return execFileSync("git", args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return undefined;
	}
}
