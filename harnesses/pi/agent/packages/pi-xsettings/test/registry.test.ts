import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ACTIONS_REGISTRY_KEY, ensureActionsRegistry, registerAction } from "pi-libactions/sdk";
import { Type } from "typebox";
import { ensureXSettingsRegistry, XSETTINGS_REGISTRY_KEY } from "../src/protocol/settings.ts";
import { attachActionShortcuts } from "../src/runtime/actions.ts";
import { resolveRegistrationValues } from "../src/runtime/settings.ts";
import { createSettings, listSetting, stringListSetting } from "../src/sdk.ts";

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[ACTIONS_REGISTRY_KEY];
	delete (globalThis as Record<PropertyKey, unknown>)[XSETTINGS_REGISTRY_KEY];
});

describe("structural registries", () => {
	test("delivers values when the extension registers before the settings host", async () => {
		const received: unknown[] = [];
		const registry = ensureXSettingsRegistry();
		registry.register({
			namespace: "demo",
			label: "Demo",
			definitions: [],
			onValues: (values) => {
				received.push(values);
			},
		});

		await registry.publish("demo", { enabled: true });

		expect(received).toEqual([{ enabled: true }]);
	});

	test("typed settings use defaults standalone and accept validated host updates", async () => {
		const client = createSettings({
			namespace: "demo",
			label: "Demo",
			definitions: {
				enabled: {
					label: "Enabled",
					description: "Enable the feature.",
					category: "behavior",
					type: "boolean",
					default: false,
				},
				mode: {
					label: "Mode",
					description: "Choose behavior.",
					category: "behavior",
					type: "enum",
					default: "safe",
					options: [
						{ value: "safe", label: "Safe", description: "Use safe mode." },
						{ value: "fast", label: "Fast", description: "Use fast mode." },
					],
				},
			},
		});
		const received: Array<ReturnType<typeof client.get>> = [];

		expect(client.get()).toEqual({ enabled: false, mode: "safe" });
		const unregister = client.register((settings) => {
			received.push({ ...settings });
		});
		await ensureXSettingsRegistry().publish("demo", { enabled: true, mode: "fast" });
		expect(client.get()).toEqual({ enabled: true, mode: "fast" });
		expect(received).toEqual([{ enabled: true, mode: "fast" }]);

		await ensureXSettingsRegistry().publish("demo", { enabled: "wrong", mode: "missing" });
		expect(client.get()).toEqual({ enabled: false, mode: "safe" });
		unregister();
	});

	test("dynamic multi-selects keep valid choices and drop stale options", async () => {
		const client = createSettings({
			namespace: "tools",
			label: "Tools",
			definitions: {
				deferred: {
					label: "Deferred tools",
					description: "Tools available through search.",
					category: "tools",
					type: "multi-enum",
					default: [],
					options: [
						{ value: "weather", label: "weather", description: "Weather." },
						{ value: "issues", label: "issues", description: "Issues." },
					],
					ordered: false,
				},
			},
		});
		const unregister = client.register();

		await ensureXSettingsRegistry().publish("tools", { deferred: ["weather", "removed_tool"] });

		expect(client.get().deferred).toEqual(["weather"]);
		unregister();
	});

	test("list settings infer their schema type and clone validated host values", async () => {
		const Roles = Type.Array(Type.Object({ name: Type.String() }), { minItems: 1 });
		const client = createSettings({
			namespace: "roles",
			label: "Roles",
			definitions: {
				roles: listSetting(Roles, {
					label: "Model roles",
					description: "Configure model roles.",
					category: "behavior",
					default: [{ name: "balanced" }],
					list: {
						itemLabel: "Role",
						identity: "name",
						uniqueIdentity: true,
						summary: [{ path: ["name"] }],
						minItems: 1,
						newItem: { name: "role" },
						fields: [{ key: "name", label: "Name", description: "Role name.", type: "string" }],
					},
				}),
			},
		});
		const unregister = client.register();
		const next = [{ name: "task" }];

		const registry = ensureXSettingsRegistry();
		await registry.publish("roles", { roles: next });
		expect(client.get().roles).toEqual(next);
		next[0]!.name = "mutated-after-save";
		expect(client.get().roles[0]?.name).toBe("task");
		unregister();
	});

	test("list settings reject malformed host values and retain their typed default", async () => {
		const Roles = Type.Array(Type.Object({ name: Type.String() }), { minItems: 1 });
		const client = createSettings({
			namespace: "roles",
			label: "Roles",
			definitions: {
				roles: listSetting(Roles, {
					label: "Roles",
					description: "Configure roles.",
					category: "behavior",
					default: [{ name: "default" }],
					list: {
						itemLabel: "Role",
						identity: "name",
						uniqueIdentity: true,
						summary: [{ path: ["name"] }],
						minItems: 1,
						newItem: { name: "role" },
						fields: [{ key: "name", label: "Name", description: "Role name.", type: "string" }],
					},
				}),
			},
		});
		const unregister = client.register();

		await ensureXSettingsRegistry().publish("roles", { roles: [{ name: 42 }] });

		expect(client.get().roles).toEqual([{ name: "default" }]);
		unregister();
	});

	test("string-list settings infer string arrays and enforce their minimum length", async () => {
		const client = createSettings({
			namespace: "annotations",
			label: "Annotations",
			definitions: {
				reactions: stringListSetting({
					label: "Reactions",
					description: "Ordered reaction presets.",
					category: "interaction",
					default: ["👍 Looks good"],
					minItems: 1,
				}),
			},
		});
		const unregister = client.register();

		await ensureXSettingsRegistry().publish("annotations", { reactions: ["✅ Approved", "❓ Clarify"] });
		expect(client.get().reactions).toEqual(["✅ Approved", "❓ Clarify"]);

		await ensureXSettingsRegistry().publish("annotations", { reactions: [] });
		expect(client.get().reactions).toEqual(["👍 Looks good"]);

		await ensureXSettingsRegistry().publish("annotations", { reactions: ["valid", 42] });
		expect(client.get().reactions).toEqual(["👍 Looks good"]);
		unregister();
	});

	test("string-list settings reject a compiled default shorter than minItems", () => {
		expect(() =>
			createSettings({
				namespace: "annotations",
				label: "Annotations",
				definitions: {
					reactions: stringListSetting({
						label: "Reactions",
						description: "Ordered reaction presets.",
						category: "interaction",
						default: [],
						minItems: 1,
					}),
				},
			}),
		).toThrow('Invalid default for string-list setting "reactions".');
	});

	test("string-list settings reject an invalid minimum", () => {
		expect(() =>
			createSettings({
				namespace: "annotations",
				label: "Annotations",
				definitions: {
					reactions: stringListSetting({
						label: "Reactions",
						description: "Ordered reaction presets.",
						category: "interaction",
						default: [],
						minItems: -1,
					}),
				},
			}),
		).toThrow('Invalid default for string-list setting "reactions".');
	});

	test("enum options can follow identities from a sibling list", async () => {
		const Roles = Type.Array(Type.Object({ name: Type.String() }), { minItems: 1 });
		const client = createSettings({
			namespace: "roles",
			label: "Roles",
			definitions: {
				defaultRole: {
					label: "Default role",
					description: "Default role name.",
					category: "behavior",
					type: "enum",
					default: "balanced",
					options: { source: "setting", setting: "roles", field: "name" },
				},
				roles: listSetting(Roles, {
					label: "Roles",
					description: "Role list.",
					category: "behavior",
					default: [{ name: "balanced" }],
					list: {
						itemLabel: "Role",
						identity: "name",
						uniqueIdentity: true,
						summary: [{ path: ["name"] }],
						minItems: 1,
						newItem: { name: "role" },
						fields: [{ key: "name", label: "Name", description: "Role name.", type: "string" }],
					},
				}),
			},
		});
		const unregister = client.register();
		await ensureXSettingsRegistry().publish("roles", {
			defaultRole: "missing",
			roles: [{ name: "tiny" }, { name: "task" }],
		});

		expect(client.get()).toEqual({ defaultRole: "tiny", roles: [{ name: "tiny" }, { name: "task" }] });
		unregister();
	});

	test("loads configured action keys before registering the shortcut", async () => {
		let shortcut: { key: string; handler: (ctx: ExtensionContext) => void | Promise<void> } | undefined;
		attachActionShortcuts(
			{
				registerShortcut(key, options) {
					shortcut = { key, handler: options.handler };
				},
			},
			{ "demo.toggle": ["ctrl+,"] },
		);
		let called = false;
		const unregister = registerAction({
			id: "demo.toggle",
			description: "Toggle demo",
			run: () => {
				called = true;
			},
		});

		expect(shortcut?.key).toBe("ctrl+,");
		await shortcut?.handler({} as ExtensionContext);
		expect(called).toBe(true);
		unregister();
	});

	test("registers every configured key and no implicit key for unbound actions", async () => {
		const shortcuts: Array<{ key: string; handler: (ctx: ExtensionContext) => void | Promise<void> }> = [];
		const registry = ensureActionsRegistry();
		attachActionShortcuts(
			{
				registerShortcut(key, options) {
					shortcuts.push({ key, handler: options.handler });
				},
			},
			{ "demo.toggle": ["ctrl+,", "alt+g"] },
		);
		let calls = 0;
		registry.register({
			id: "unbound.toggle",
			description: "Unbound",
			run: () => {
				calls += 100;
			},
		});
		registry.register({
			id: "demo.toggle",
			description: "Toggle demo",
			run: () => {
				calls += 1;
			},
		});

		for (const shortcut of shortcuts) await shortcut.handler({} as ExtensionContext);

		expect(shortcuts.map(({ key }) => key)).toEqual(["ctrl+,", "alt+g"]);
		expect(calls).toBe(2);
	});

	test("shortcuts use the action replaced by a resumed session", async () => {
		let shortcut: { handler: (ctx: ExtensionContext) => void | Promise<void> } | undefined;
		const registry = ensureActionsRegistry();
		let oldCalls = 0;
		let resumedCalls = 0;
		registry.register({
			id: "demo.toggle",
			description: "Toggle demo",
			run: () => {
				oldCalls += 1;
			},
		});
		attachActionShortcuts(
			{
				registerShortcut(_key, options) {
					shortcut = { handler: options.handler };
				},
			},
			{ "demo.toggle": ["ctrl+,"] },
		);

		registry.register({
			id: "demo.toggle",
			description: "Toggle demo",
			run: () => {
				resumedCalls += 1;
			},
		});
		await shortcut?.handler({} as ExtensionContext);

		expect(oldCalls).toBe(0);
		expect(resumedCalls).toBe(1);
	});

	test("reads extension values from each setting category", () => {
		const registration = {
			namespace: "demo",
			label: "Demo",
			definitions: [
				{
					key: "visible",
					label: "Visible",
					description: "Show the feature.",
					category: "appearance" as const,
					type: "boolean" as const,
					default: false,
				},
				{
					key: "mode",
					label: "Mode",
					description: "Choose behavior.",
					category: "behavior" as const,
					type: "enum" as const,
					default: "safe",
					options: [
						{ value: "safe", label: "Safe", description: "Use safe mode." },
						{ value: "fast", label: "Fast", description: "Use fast mode." },
					],
				},
			],
		};

		expect(
			resolveRegistrationValues(registration, {
				appearance: { demo: { visible: true } },
				behavior: { demo: { mode: "fast" } },
			}),
		).toEqual({ visible: true, mode: "fast" });
	});
});
