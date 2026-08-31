import { describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { type SettingsRecord, stringifyXSettings, XSettingsStore } from "../src/config/store.ts";
import type { SettingValue } from "../src/protocol/settings.ts";

describe("xsettings.toml", () => {
	test("updates one setting without dropping unknown tables", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-xsettings-"));
		try {
			const path = join(directory, "xsettings.toml");
			await writeFile(path, '[unknown]\nvalue = "keep"\n\n[behavior]\ndemo.enabled = false\n');
			const store = new XSettingsStore(path);

			await store.set(["behavior", "demo", "enabled"], true);

			const document = parse(await readFile(path, "utf8")) as SettingsRecord;
			expect(document).toEqual({
				unknown: { value: "keep" },
				behavior: { demo: { enabled: true } },
			});
			const source = await readFile(path, "utf8");
			expect(source).toContain("[behavior]\ndemo.enabled = true");
			expect(source).not.toContain("[behavior.demo]");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("writes through a managed symlink without replacing it", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-xsettings-link-"));
		const target = join(directory, "repository.toml");
		const link = join(directory, "xsettings.toml");
		try {
			await writeFile(target, '[appearance]\npi.theme = "dark"\n');
			await symlink(target, link);

			await new XSettingsStore(link).set(["appearance", "pi", "theme"], "light");

			expect((await lstat(link)).isSymbolicLink()).toBe(true);
			expect(await readFile(target, "utf8")).toContain('theme = "light"');
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("removes a setting and prunes its empty owner and category tables", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-xsettings-unset-"));
		try {
			const path = join(directory, "xsettings.toml");
			await writeFile(path, '[tools]\npi.defaultTools = []\n\n[unknown]\nvalue = "keep"\n');
			const store = new XSettingsStore(path);

			const document = await store.unset(["tools", "pi", "defaultTools"]);

			expect(document).toEqual({ unknown: { value: "keep" } });
			expect(await readFile(path, "utf8")).toBe('[unknown]\nvalue = "keep"\n');
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("writes owner-prefixed keys inside fixed category tables", () => {
		expect(
			stringifyXSettings({
				appearance: { pi: { theme: "tokyo-night" } },
				behavior: { "pi-codex-native": { cacheDiagnostics: "status" } },
				interaction: { pi: { steeringMode: "all" } },
				tools: { pi: { defaultTools: [] } },
			}),
		).toBe(
			[
				"[appearance]",
				'pi.theme = "tokyo-night"',
				"",
				"[behavior]",
				'pi-codex-native.cacheDiagnostics = "status"',
				"",
				"[interaction]",
				'pi.steeringMode = "all"',
				"",
				"[tools]",
				"pi.defaultTools = []",
				"",
			].join("\n"),
		);
	});

	test("atomically replaces a structured setting with nested arrays of tables", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-xsettings-catalog-"));
		try {
			const path = join(directory, "xsettings.toml");
			await writeFile(path, "# settings\n");
			const store = new XSettingsStore(path);
			const roles: SettingValue = [
				{
					name: "balanced",
					description: "General work",
					candidates: [
						{ model: "openai/primary", thinking: "medium" },
						{ model: "openai/fallback", thinking: "high", serviceTier: "priority" },
					],
				},
				{
					name: "task",
					candidates: [{ model: "openai/task", thinking: "xhigh" }],
				},
			];

			await store.set(["behavior", "demo", "roles"], roles);

			const source = await readFile(path, "utf8");
			expect(source).toContain("[[behavior.demo.roles]]");
			expect(source).toContain("[[behavior.demo.roles.candidates]]");
			expect(parse(source)).toEqual({ behavior: { demo: { roles } } });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("preserves an explicitly configured empty nested table", () => {
		const source = stringifyXSettings({ behavior: { demo: { catalog: {} } } });

		expect(source).toBe("[behavior.demo.catalog]\n");
		expect(parse(source)).toEqual({ behavior: { demo: { catalog: {} } } });
	});
});
