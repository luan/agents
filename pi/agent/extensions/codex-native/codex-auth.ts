import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `~/.codex/auth.json`, shared by every local caller of the Codex backend: `web-run.ts` and `image-gen.ts`. */
export function codexAuthPath(): string {
	return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
}

export function codexChatGptCredentials(): { token: string; accountId?: string } {
	const path = codexAuthPath();
	let parsed: { tokens?: { access_token?: string; account_id?: string } } = {};
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error(`Codex ChatGPT auth not readable at ${path}; run codex login`);
	}
	const token = parsed.tokens?.access_token;
	if (!token) throw new Error(`Codex ChatGPT auth not found in ${path}; run codex login`);
	return { token, accountId: parsed.tokens?.account_id };
}
