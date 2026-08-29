import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerAction } from "pi-libactions/sdk";
import { registerSidePanelProvider } from "pi-libtui";
import { ensureEditorRegistry } from "pi-libtui/editor";
import { ensureMouseRegistry } from "pi-libtui/mouse";
import { TuicrManager } from "./manager.ts";
import { ReviewCommentAttachments } from "./review-comments.ts";
import { createTuicrRuntime } from "./tuicr-review.ts";

export default function tuicrExtension(pi: ExtensionAPI): void {
	const runtime = createTuicrRuntime({
		run: (command, args, cwd) =>
			execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
		fallbackSessionDirectory: tuicrSessionDirectory(process.platform, homedir(), process.env),
		sessionFiles: (directory) =>
			existsSync(directory)
				? readdirSync(directory)
						.filter((name) => name.endsWith(".json"))
						.map((name) => join(directory, name))
				: [],
		readSessionFile: (path) => {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return undefined;
			}
		},
		watchSessionDirectory: (directory, listener) => {
			if (!existsSync(directory)) return undefined;
			const watcher = watch(directory, { persistent: false }, (_event, filename) =>
				listener(filename?.endsWith(".json") ? join(directory, filename) : undefined),
			);
			return () => watcher.close();
		},
		schedule: (delayMs, callback) => {
			const timer = setTimeout(callback, delayMs);
			return () => clearTimeout(timer);
		},
	});
	let manager: TuicrManager | undefined;
	let comments: ReviewCommentAttachments | undefined;
	let unregisterProvider: (() => void) | undefined;
	let activeSession: ExtensionContext["sessionManager"] | undefined;
	let unregisterAction: (() => void) | undefined;

	pi.on("session_start", (_event, nextContext) => {
		if (nextContext.mode !== "tui" || !nextContext.hasUI) return;
		unregisterProvider?.();
		manager?.dispose();
		comments?.dispose();
		const sessionComments = new ReviewCommentAttachments(nextContext, ensureEditorRegistry(), ensureMouseRegistry());
		comments = sessionComments;
		manager = new TuicrManager(nextContext, runtime, (items) => sessionComments.publish(items), globalThis);
		activeSession = nextContext.sessionManager;
		unregisterAction?.();
		unregisterAction = registerAction({
			id: "side-panel.tuicr.open",
			description: "Review changes with tuicr",
			run: () => manager?.open(),
		});
		unregisterProvider = registerSidePanelProvider(
			{
				id: "pi-tuicr",
				session: nextContext,
				attach(panel) {
					return manager?.attachPanel(panel);
				},
			},
			globalThis,
		);
	});
	pi.on("input", (event) => {
		if (event.source !== "interactive") return { action: "continue" };
		const text = comments?.transform(event.text);
		return text
			? { action: "transform", text, ...(event.images ? { images: event.images } : {}) }
			: { action: "continue" };
	});
	pi.on("message_start", (event) => comments?.accept(event.message));
	pi.on("session_shutdown", (event, context) => {
		if (context.mode !== "tui" || !context.hasUI || activeSession !== context.sessionManager) return;
		unregisterProvider?.();
		unregisterProvider = undefined;
		manager?.dispose();
		comments?.dispose();
		manager = undefined;
		comments = undefined;
		activeSession = undefined;
		if (event.reason === "reload" || event.reason === "quit") {
			unregisterAction?.();
			unregisterAction = undefined;
		}
	});
}

function tuicrSessionDirectory(platform: NodeJS.Platform, home: string, environment: NodeJS.ProcessEnv): string {
	if (platform === "darwin") return join(home, "Library", "Application Support", "tuicr", "reviews", "sessions");
	if (platform === "win32") return join(environment.LOCALAPPDATA ?? home, "tuicr", "reviews", "sessions");
	return join(environment.XDG_DATA_HOME ?? join(home, ".local", "share"), "tuicr", "reviews", "sessions");
}
