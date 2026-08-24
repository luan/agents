import { spawn } from "node:child_process";
import { relative } from "node:path";
import { resolveApplyPatchBinary } from "./binary.ts";
import { parsePatchActions } from "./patch.ts";
import { ExecutePatchError, type ExecutePatchResult, type ParsedPatchAction } from "./types.ts";

const MAX_DIAGNOSTIC_CHARS = 8_192;

interface RustApplyPatchJson {
	status: "success" | "failure";
	error?: string | null;
	result: ExecutePatchResult;
}

function boundedDiagnostic(value: string): string {
	const normalized = value.trim();
	return normalized.length <= MAX_DIAGNOSTIC_CHARS ? normalized : `${normalized.slice(0, MAX_DIAGNOSTIC_CHARS)}…`;
}

function parseRustApplyPatchJson(stdout: string): RustApplyPatchJson {
	for (const line of stdout.trim().split("\n").reverse()) {
		try {
			const parsed = JSON.parse(line) as Partial<RustApplyPatchJson>;
			if ((parsed.status === "success" || parsed.status === "failure") && parsed.result) {
				return parsed as RustApplyPatchJson;
			}
		} catch {
			// The native command writes progress lines before its final JSON line.
		}
	}
	throw new Error(`apply_patch returned invalid structured JSON: ${boundedDiagnostic(stdout)}`);
}

function runApplyPatchBinary(
	binary: string,
	cwd: string,
	patchText: string,
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
	return new Promise((resolve, reject) => {
		const child = spawn(binary, [], {
			cwd,
			env: { ...process.env, PI_APPLY_PATCH_JSON: "1" },
			stdio: ["pipe", "pipe", "pipe"],
			signal,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			callback();
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			if (stderr.length <= MAX_DIAGNOSTIC_CHARS) stderr += chunk;
		});
		child.on("error", (error) => finish(() => reject(error)));
		child.on("close", (code) => finish(() => resolve({ stdout, stderr, code })));
		child.stdin.on("error", (error) => {
			child.kill();
			finish(() => reject(error));
		});
		child.stdin.end(patchText);
	});
}

function displayPatchPath(cwd: string, path: string): string {
	if (!path.startsWith("/")) return path;
	const display = relative(cwd, path);
	return display && !display.startsWith("..") && !display.startsWith("/") ? display : path;
}

function actionMatchesError(error: string, action: ParsedPatchAction): boolean {
	return error.includes(action.path) || (action.movePath !== undefined && error.includes(action.movePath));
}

export async function executePatchWithRust({
	cwd,
	patchText,
	signal,
	binary = resolveApplyPatchBinary(),
}: {
	cwd: string;
	patchText: string;
	signal?: AbortSignal;
	binary?: string;
}): Promise<ExecutePatchResult> {
	const child = await runApplyPatchBinary(binary, cwd, patchText, signal);
	let parsed: RustApplyPatchJson;
	try {
		parsed = parseRustApplyPatchJson(child.stdout);
	} catch (error) {
		const diagnostic = boundedDiagnostic(child.stderr);
		if (child.code !== 0 && diagnostic) throw new Error(diagnostic, { cause: error });
		throw error;
	}
	if (parsed.status === "success" && child.code === 0) return parsed.result;

	const message =
		boundedDiagnostic(parsed.error ?? child.stderr) || `apply_patch exited with code ${child.code ?? "unknown"}`;
	let actions: ParsedPatchAction[] = [];
	try {
		actions = parsePatchActions(patchText).map((action) => ({
			...action,
			path: displayPatchPath(cwd, action.path),
			movePath: action.movePath === undefined ? undefined : displayPatchPath(cwd, action.movePath),
		}));
	} catch {
		// Rust owns authoritative parsing and error reporting.
	}
	const failedAction = actions.find((action) => actionMatchesError(message, action));
	throw new ExecutePatchError(message, parsed.result, failedAction ? [{ action: failedAction, message }] : []);
}
