import { dirname, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const COMMAND = "tuicr";

interface TuicrSession {
	readonly path: string;
	readonly commentCount: number;
}

export interface TuicrComment {
	readonly id: string;
	readonly content: string;
	readonly location?: string;
	readonly path?: string;
	readonly commentType?: string;
}

export interface TuicrReview {
	readonly args: readonly string[];
	watch(listener: (comments: readonly TuicrComment[]) => void): () => void;
	comments(): readonly TuicrComment[];
}

export type TuicrTargetId =
	| "working-tree"
	| "branch-working-tree"
	| "branch"
	| "last-commit"
	| "pick-commits"
	| "all-files"
	| "custom-revset"
	| "pull-request";

export interface TuicrTarget {
	readonly id: TuicrTargetId;
	readonly label: string;
	readonly args?: readonly string[];
}

export interface TuicrRuntime {
	capture(command: string, args: readonly string[], cwd: string): string | undefined;
	sessionDirectories(cwd: string): readonly string[];
	sessionFiles(directory: string): readonly string[];
	readSessionFile(path: string): string | undefined;
	watchSessionDirectory(directory: string, listener: (path?: string) => void): (() => void) | undefined;
	schedule(delayMs: number, callback: () => void): () => void;
}

export interface TuicrRuntimeDependencies {
	run(command: string, args: readonly string[], cwd: string): string;
	readonly fallbackSessionDirectory: string;
	sessionFiles(directory: string): readonly string[];
	readSessionFile(path: string): string | undefined;
	watchSessionDirectory(directory: string, listener: (path?: string) => void): (() => void) | undefined;
	schedule(delayMs: number, callback: () => void): () => void;
}

export type TuicrTargetsResult =
	| { readonly ok: true; readonly targets: readonly TuicrTarget[] }
	| { readonly ok: false; readonly message: string };

export function createTuicrRuntime(dependencies: TuicrRuntimeDependencies): TuicrRuntime {
	const capture = (command: string, args: readonly string[], cwd: string): string | undefined => {
		try {
			return dependencies.run(command, args, cwd).trim();
		} catch {
			return undefined;
		}
	};
	const runtime: TuicrRuntime = {
		capture,
		sessionDirectories(cwd) {
			const discovered = sessions(cwd, runtime).map((session) => dirname(session.path));
			return [...new Set([...discovered, dependencies.fallbackSessionDirectory])];
		},
		sessionFiles: dependencies.sessionFiles,
		readSessionFile: dependencies.readSessionFile,
		watchSessionDirectory: dependencies.watchSessionDirectory,
		schedule: dependencies.schedule,
	};
	return runtime;
}

// type-boundary: tuicr JSON output is untyped external process data; these parsers validate every consumed field.
type TuicrJsonBoundary = unknown;

export function listTuicrTargets(cwd: string, runtime: TuicrRuntime): TuicrTargetsResult {
	if (runtime.capture(COMMAND, ["--version"], cwd) === undefined) {
		return { ok: false, message: "Could not start tuicr — is it on your PATH?" };
	}
	const base = baseBranch(cwd, runtime);
	return {
		ok: true,
		targets: [
			{ id: "working-tree", label: "Uncommitted changes", args: ["-w"] },
			...(base
				? ([
						{
							id: "branch-working-tree",
							label: `Branch vs ${base} (+ uncommitted)`,
							args: ["-r", `${base}..HEAD`, "-w"],
						},
						{ id: "branch", label: `Branch vs ${base}`, args: ["-r", `${base}..HEAD`] },
					] as const)
				: []),
			{ id: "last-commit", label: "Last commit", args: ["-r", "HEAD~1..HEAD"] },
			{ id: "pick-commits", label: "Pick commits", args: [] },
			{ id: "all-files", label: "Every tracked file", args: ["-A"] },
			{ id: "custom-revset", label: "Custom revset…" },
			{ id: "pull-request", label: "Pull request…" },
		],
	};
}

export async function prepareTuicrReview(
	context: ExtensionContext,
	target: TuicrTarget,
	runtime: TuicrRuntime,
): Promise<TuicrReview | undefined> {
	const args = await targetArgs(context, target);
	if (!args) return undefined;
	let seen: ReadonlySet<string>;
	let directories: readonly string[];
	try {
		seen = new Set(allComments(context.cwd, runtime).map((comment) => comment.id));
		directories = runtime.sessionDirectories(context.cwd);
	} catch (error) {
		context.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return undefined;
	}
	return {
		args,
		...createTuicrCommentFeed(context.cwd, seen, directories, runtime),
	};
}

async function targetArgs(context: ExtensionContext, target: TuicrTarget): Promise<readonly string[] | undefined> {
	if (target.args) return target.args;
	if (target.id === "custom-revset") {
		const revset = (await context.ui.input("Revset:", "e.g. HEAD~3..HEAD"))?.trim();
		return revset ? ["-r", revset] : undefined;
	}
	if (target.id === "pull-request") {
		const target = (await context.ui.input("PR:", "number, owner/repo#N, or URL"))?.trim();
		return target ? ["pr", target] : undefined;
	}
	return undefined;
}

function baseBranch(cwd: string, runtime: TuicrRuntime): string | undefined {
	const remoteHead = runtime.capture("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
	const current = runtime.capture("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
	for (const ref of [...(remoteHead ? [remoteHead] : []), "origin/main", "origin/master", "main", "master"]) {
		if (ref !== current && runtime.capture("git", ["rev-parse", "--verify", "--quiet", ref], cwd)) return ref;
	}
	return undefined;
}

function allComments(cwd: string, runtime: TuicrRuntime): TuicrComment[] {
	return sessions(cwd, runtime).flatMap((session) =>
		session.commentCount > 0 ? comments(["review", "comments", "--session", session.path], cwd, runtime) : [],
	);
}

function sessions(cwd: string, runtime: TuicrRuntime): TuicrSession[] {
	return parseSessions(json(["review", "list", "--all"], cwd, runtime));
}

function parseSessions(value: TuicrJsonBoundary): TuicrSession[] {
	if (!Array.isArray(value)) throw new Error("tuicr review list did not return a JSON array");
	return value.map((item) => {
		if (!isRecord(item) || typeof item.path !== "string" || typeof item.comment_count !== "number") {
			throw new Error("tuicr review list returned an invalid session");
		}
		return { path: item.path, commentCount: item.comment_count };
	});
}

function comments(args: readonly string[], cwd: string, runtime: TuicrRuntime): TuicrComment[] {
	return parseComments(json(args, cwd, runtime));
}

function parseComments(value: TuicrJsonBoundary): TuicrComment[] {
	if (!Array.isArray(value)) throw new Error("tuicr review comments did not return a JSON array");
	return value.map((item) => {
		if (!isRecord(item) || typeof item.id !== "string" || typeof item.content !== "string") {
			throw new Error("tuicr review comments returned an invalid comment");
		}
		return {
			id: item.id,
			content: item.content,
			...(typeof item.location === "string" ? { location: item.location } : {}),
			...(typeof item.path === "string" ? { path: item.path } : {}),
			...(typeof item.comment_type === "string" ? { commentType: item.comment_type } : {}),
		};
	});
}

function json(args: readonly string[], cwd: string, runtime: TuicrRuntime): TuicrJsonBoundary {
	const output = runtime.capture(COMMAND, args, cwd);
	if (output === undefined) throw new Error(`tuicr ${args.join(" ")} failed`);
	return JSON.parse(output) as TuicrJsonBoundary;
}

function isRecord(value: TuicrJsonBoundary): value is Record<string, TuicrJsonBoundary> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createTuicrCommentFeed(
	cwd: string,
	seen: ReadonlySet<string>,
	directories: readonly string[],
	runtime: Pick<TuicrRuntime, "sessionFiles" | "readSessionFile" | "watchSessionDirectory" | "schedule">,
): Pick<TuicrReview, "watch" | "comments"> {
	const listeners = new Set<(comments: readonly TuicrComment[]) => void>();
	const stopWatchers: Array<() => void> = [];
	const current = new Map<string, TuicrComment>();
	const pendingPaths = new Set<string>();
	let cancelScheduled: (() => void) | undefined;
	const freshComments = (): TuicrComment[] =>
		directComments(directories, cwd, runtime).filter((comment) => !seen.has(comment.id));
	const publish = (): void => {
		cancelScheduled = undefined;
		const changed =
			pendingPaths.size > 0
				? [...pendingPaths].flatMap((path) => commentsFromSessionFile(path, cwd, runtime))
				: freshComments();
		pendingPaths.clear();
		for (const comment of changed) {
			if (!seen.has(comment.id)) current.set(comment.id, comment);
		}
		const fresh = [...current.values()];
		for (const listener of listeners) listener(fresh);
	};
	const schedule = (path?: string): void => {
		if (path) pendingPaths.add(path);
		cancelScheduled?.();
		cancelScheduled = runtime.schedule(25, publish);
	};
	return {
		watch(listener) {
			listeners.add(listener);
			if (stopWatchers.length === 0) {
				for (const directory of directories) {
					try {
						const stop = runtime.watchSessionDirectory(directory, (path) => schedule(path));
						if (stop) stopWatchers.push(stop);
					} catch {
						// Optional session directories can disappear between discovery and watch setup.
					}
				}
			}
			schedule();
			return () => {
				listeners.delete(listener);
				if (listeners.size > 0) return;
				cancelScheduled?.();
				cancelScheduled = undefined;
				pendingPaths.clear();
				current.clear();
				for (const stop of stopWatchers.splice(0)) stop();
			};
		},
		comments: freshComments,
	};
}

function directComments(
	directories: readonly string[],
	cwd: string,
	runtime: Pick<TuicrRuntime, "sessionFiles" | "readSessionFile">,
): TuicrComment[] {
	return directories.flatMap((directory) => {
		try {
			return runtime
				.sessionFiles(directory)
				.filter((path) => path.endsWith(".json"))
				.flatMap((path) => commentsFromSessionFile(path, cwd, runtime));
		} catch {
			return [];
		}
	});
}

function commentsFromSessionFile(
	path: string,
	cwd: string,
	runtime: Pick<TuicrRuntime, "readSessionFile">,
): TuicrComment[] {
	let value: TuicrJsonBoundary;
	try {
		const source = runtime.readSessionFile(path);
		if (source === undefined) return [];
		value = JSON.parse(source) as TuicrJsonBoundary;
	} catch {
		return [];
	}
	if (!isRecord(value) || typeof value.repo_path !== "string" || resolve(value.repo_path) !== resolve(cwd)) return [];
	const result = parseDirectCommentList(value.review_comments);
	if (!isRecord(value.files)) return result;
	for (const file of Object.values(value.files)) {
		if (!isRecord(file) || typeof file.path !== "string") continue;
		result.push(...parseDirectCommentList(file.file_comments, file.path));
		if (!isRecord(file.line_comments)) continue;
		for (const [line, commentsAtLine] of Object.entries(file.line_comments)) {
			result.push(...parseDirectCommentList(commentsAtLine, `${file.path}:${line}`));
		}
	}
	return result;
}

function parseDirectCommentList(value: TuicrJsonBoundary, location?: string): TuicrComment[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (!isRecord(item) || typeof item.id !== "string" || typeof item.content !== "string") return [];
		return [
			{
				id: item.id,
				content: item.content,
				...(location ? { location } : {}),
				...(typeof item.comment_type === "string" ? { commentType: item.comment_type } : {}),
			},
		];
	});
}

export function formatTuicrComments(commentsToFormat: readonly TuicrComment[]): string {
	const lines = commentsToFormat.map((comment, index) => {
		const anchor = comment.location ?? comment.path;
		const type = comment.commentType && comment.commentType !== "none" ? ` [${comment.commentType.toUpperCase()}]` : "";
		const body = comment.content.trim().replace(/\n+/g, " ");
		return anchor ? `${index + 1}. \`${anchor}\`${type} - ${body}` : `${index + 1}.${type} - ${body}`;
	});
	return ["I reviewed your changes. Please address these comments:", "", ...lines].join("\n");
}
