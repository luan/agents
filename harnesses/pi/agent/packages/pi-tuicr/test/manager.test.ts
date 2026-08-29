import { expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TuicrManager } from "../src/manager.ts";
import type { TuicrRuntime } from "../src/tuicr-review.ts";

test("does not open an overlay after its session was disposed", async () => {
	let resolveSelection: ((value: string | undefined) => void) | undefined;
	let overlays = 0;
	const context = {
		cwd: "/tmp",
		ui: {
			theme: {},
			notify() {},
			select: () =>
				new Promise<string | undefined>((resolve) => {
					resolveSelection = resolve;
				}),
			custom: async () => {
				overlays += 1;
			},
		},
	} as never as ExtensionContext;
	const runtime: TuicrRuntime = {
		capture: (command, args) => (command === "tuicr" && args[0] === "--version" ? "1.0.0" : undefined),
		sessionDirectories: () => [],
		sessionFiles: () => [],
		readSessionFile: () => undefined,
		watchSessionDirectory: () => undefined,
		schedule: () => () => {},
	};
	const manager = new TuicrManager(context, runtime, () => {}, Object.create(null) as typeof globalThis);

	const opening = manager.open();
	manager.dispose();
	resolveSelection?.("Uncommitted changes");
	await opening;

	expect(overlays).toBe(0);
});
