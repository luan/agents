import { expect, test } from "bun:test";
import { join } from "node:path";
import { createTuicrCommentFeed, createTuicrRuntime, listTuicrTargets } from "../src/tuicr-review.ts";

test("reports unavailable tuicr without notifying from target discovery", () => {
	const runtime = createTuicrRuntime(
		runtimeDependencies(() => {
			throw new Error("missing");
		}),
	);
	expect(listTuicrTargets("/tmp/project", runtime)).toEqual({
		ok: false,
		message: "Could not start tuicr — is it on your PATH?",
	});
});

test("streams changed tuicr session files without polling its CLI or real time", () => {
	const repo = "/tmp/repo";
	const sessions = "/tmp/sessions";
	const path = join(sessions, "review.json");
	const files = new Map([[path, session(repo, [{ id: "seen", content: "Existing" }])]]);
	let changedPath: ((path?: string) => void) | undefined;
	let scheduled: (() => void) | undefined;
	const feed = createTuicrCommentFeed(repo, new Set(["seen"]), [sessions], {
		sessionFiles: () => [...files.keys()],
		readSessionFile: (file) => files.get(file),
		watchSessionDirectory: (_directory, listener) => {
			changedPath = listener;
			return () => {
				changedPath = undefined;
			};
		},
		schedule: (_delay, callback) => {
			scheduled = callback;
			return () => {
				if (scheduled === callback) scheduled = undefined;
			};
		},
	});
	expect(feed.comments()).toEqual([]);
	let published: readonly { id: string; content: string }[] = [];
	const stop = feed.watch((comments) => {
		published = comments;
	});
	scheduled?.();
	files.set(
		path,
		session(repo, [
			{ id: "seen", content: "Existing" },
			{ id: "new", content: "Live" },
		]),
	);
	changedPath?.(path);
	scheduled?.();
	expect(published).toContainEqual(expect.objectContaining({ id: "new", content: "Live" }));
	stop();
});

function runtimeDependencies(run: () => string): Parameters<typeof createTuicrRuntime>[0] {
	return {
		run,
		fallbackSessionDirectory: "/tmp/tuicr-sessions",
		sessionFiles: () => [],
		readSessionFile: () => undefined,
		watchSessionDirectory: () => undefined,
		schedule: (_delay, callback) => {
			callback();
			return () => {};
		},
	};
}

function session(repoPath: string, comments: readonly { id: string; content: string }[]): string {
	return JSON.stringify({
		repo_path: repoPath,
		review_comments: comments.map((comment) => ({ ...comment, comment_type: "none" })),
		files: {},
	});
}
