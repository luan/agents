import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CONTEXT_WINDOW_SOURCES_KEY,
	ensureContextWindowSourceRegistry,
	requestedContextWindowPreset,
} from "../src/sdk.ts";

describe("context-window source registry", () => {
	test("supports consumer-first registration and disposal", () => {
		const scope = Object.create(null) as typeof globalThis;
		const registry = ensureContextWindowSourceRegistry(scope);
		const source = { id: "role", preset: () => "large" as const };
		const remove = registry.register(source);
		expect(remove).toBeFunction();
		remove();
	});

	test("keeps same-id registrations independent", () => {
		const original = Reflect.get(globalThis, CONTEXT_WINDOW_SOURCES_KEY);
		try {
			Reflect.deleteProperty(globalThis, CONTEXT_WINDOW_SOURCES_KEY);
			const registry = ensureContextWindowSourceRegistry();
			const removeFirst = registry.register({ id: "role", preset: () => "large" });
			const removeSecond = registry.register({ id: "role", preset: () => "max" });

			expect(requestedContextWindowPreset({} as ExtensionContext)).toBe("large");
			removeSecond();
			expect(requestedContextWindowPreset({} as ExtensionContext)).toBe("large");
			removeFirst();
			expect(requestedContextWindowPreset({} as ExtensionContext)).toBeUndefined();
		} finally {
			if (original === undefined) Reflect.deleteProperty(globalThis, CONTEXT_WINDOW_SOURCES_KEY);
			else Reflect.set(globalThis, CONTEXT_WINDOW_SOURCES_KEY, original);
		}
	});

	test("shares sources across separately loaded package copies", async () => {
		const original = Reflect.get(globalThis, CONTEXT_WINDOW_SOURCES_KEY);
		const temporary = await mkdtemp(join(tmpdir(), "pi-libcontext-copy-"));
		try {
			Reflect.deleteProperty(globalThis, CONTEXT_WINDOW_SOURCES_KEY);
			const registry = ensureContextWindowSourceRegistry();
			registry.register({ id: "role", preset: () => "large" });

			const copiedSource = join(temporary, "src");
			await cp(resolve(import.meta.dir, "../src"), copiedSource, { recursive: true });
			const copiedSdk = (await import(
				pathToFileURL(join(copiedSource, "sdk.ts")).href
			)) as typeof import("../src/sdk.ts");
			expect(copiedSdk.requestedContextWindowPreset({} as ExtensionContext)).toBe("large");
		} finally {
			if (original === undefined) Reflect.deleteProperty(globalThis, CONTEXT_WINDOW_SOURCES_KEY);
			else Reflect.set(globalThis, CONTEXT_WINDOW_SOURCES_KEY, original);
			await rm(temporary, { recursive: true, force: true });
		}
	});
});
