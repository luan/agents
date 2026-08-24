import { isAbsolute, resolve } from "node:path";
import type { ParsedPatchAction } from "./types.ts";

function normalizePatchPath(path: string): string {
	const trimmed = path.trim();
	const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
	return withoutAt.replace(/^['"]|['"]$/g, "");
}

export function resolvePatchPath(cwd: string, patchPath: string): string {
	const normalized = normalizePatchPath(patchPath);
	if (!normalized) throw new Error("Patch path cannot be empty");
	return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

export function parsePatchActions(text: string): ParsedPatchAction[] {
	const lines = text.trim().split("\n");
	if (lines.length < 2 || !lines[0]!.startsWith("*** Begin Patch") || lines.at(-1) !== "*** End Patch") {
		throw new Error("Invalid patch text");
	}

	const actions: ParsedPatchAction[] = [];
	let index = 1;
	while (index < lines.length - 1) {
		const line = lines[index]!;
		if (line.startsWith("*** Update File: ")) {
			const path = normalizePatchPath(line.slice("*** Update File: ".length));
			index += 1;
			let movePath: string | undefined;
			if (lines[index]?.startsWith("*** Move to: ")) {
				movePath = normalizePatchPath(lines[index]!.slice("*** Move to: ".length));
				index += 1;
			}
			const bodyStart = index;
			while (index < lines.length - 1 && !/^\*\*\* (?:Update|Delete|Add) File: /.test(lines[index]!)) index += 1;
			actions.push({ type: "update", path, movePath, lines: lines.slice(bodyStart, index) });
			continue;
		}
		if (line.startsWith("*** Delete File: ")) {
			actions.push({ type: "delete", path: normalizePatchPath(line.slice("*** Delete File: ".length)) });
			index += 1;
			continue;
		}
		if (line.startsWith("*** Add File: ")) {
			const path = normalizePatchPath(line.slice("*** Add File: ".length));
			index += 1;
			const content: string[] = [];
			while (index < lines.length - 1 && !/^\*\*\* (?:Update|Delete|Add) File: /.test(lines[index]!)) {
				const added = lines[index]!;
				if (!added.startsWith("+")) throw new Error(`Invalid Add File Line: ${added}`);
				content.push(added.slice(1));
				index += 1;
			}
			actions.push({ type: "add", path, newFile: content.length === 0 ? "" : `${content.join("\n")}\n` });
			continue;
		}
		throw new Error(`Invalid patch hunk: ${line}`);
	}
	return actions;
}
