import { describe, expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, stripTerminalSequences, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { SettingDefinition, SettingRegistration, SettingValue } from "../src/protocol/settings.ts";
import { storedEnumValue, toUiField } from "../src/ui/fields.ts";
import { formatSettingValue } from "../src/ui/settings-editor.ts";
import { type SettingsScreenField, XSettingsScreen } from "../src/ui/xsettings-screen.ts";

describe("settings screen fields", () => {
	const theme = {
		bold: (text: string) => text,
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		underline: (text: string) => text,
	} as Theme;
	const defaultTools: SettingDefinition = {
		key: "defaultTools",
		label: "Built-in tools",
		description: "Built-in tools enabled when Pi starts.",
		category: "tools",
		section: "Tools",
		type: "multi-enum",
		default: [],
		ordered: false,
		options: [{ value: "read", label: "read", description: "" }],
	};

	test("distinguishes unset Pi defaults from an explicit empty tool list", () => {
		const unset = toUiField({}, undefined, defaultTools);
		const none = toUiField({ tools: { pi: { defaultTools: [] } } }, undefined, defaultTools);

		expect(unset.configured).toBe(false);
		expect(unset.value).toEqual(["read"]);
		expect(formatSettingValue(unset)).toBe("all default tools");
		expect(none.configured).toBe(true);
		expect(formatSettingValue(none)).toBe("none");
	});

	test("uses the extension as the subcategory and keeps the setting label plain", () => {
		const definition: SettingDefinition = {
			key: "mode",
			label: "Mode",
			description: "Choose a mode.",
			category: "behavior",
			section: "Ignored custom section",
			type: "enum",
			default: "off",
			options: [{ value: "off", label: "Off", description: "" }],
		};
		const registration: SettingRegistration = {
			namespace: "pi-demo",
			label: "Demo",
			definitions: [definition],
		};

		const field = toUiField({}, registration, definition);

		expect(field.section).toBe("Demo");
		expect(field.label).toBe("Mode");
	});

	test("keeps numeric enum values numeric after the picker converts them to strings", () => {
		const definition: SettingDefinition = {
			key: "editorPaddingX",
			label: "Editor padding",
			description: "Horizontal editor padding.",
			category: "appearance",
			type: "enum",
			default: 0,
			options: [
				{ value: 0, label: "0", description: "" },
				{ value: 1, label: "1", description: "" },
			],
		};

		const field = toUiField({}, undefined, definition);

		expect(field.type).toBe("enum");
		if (field.type !== "enum") throw new Error("expected enum field");
		expect(storedEnumValue(field, "1")).toBe(1);
	});

	test("keeps presentation pages independent from persisted categories", () => {
		const definition: SettingDefinition = {
			key: "fullscreenScrollbar",
			label: "Fullscreen scrollbar",
			description: "Scrollbar behavior in fullscreen mode.",
			category: "appearance",
			page: "terminal",
			type: "enum",
			default: "auto",
			options: [{ value: "auto", label: "Automatic", description: "" }],
		};

		const field = toUiField({}, undefined, definition);

		expect(field.page).toBe("terminal");
		expect(field.storagePath).toEqual(["appearance", "pi", "fullscreenScrollbar"]);
	});

	test("keeps a confirmed value when switching away from its tab and back", () => {
		initTheme("dark", false);
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		const steering: SettingsScreenField = {
			id: "pi.steeringMode",
			label: "Steering delivery",
			description: "How steering messages are delivered.",
			category: "interaction",
			section: "Message Delivery",
			storagePath: ["interaction", "pi", "steeringMode"],
			type: "enum",
			value: "one-at-a-time",
			defaultValue: "one-at-a-time",
			configured: false,
			options: [
				{ value: "one-at-a-time", label: "One at a time" },
				{ value: "all", label: "All" },
			],
		};
		const changes: SettingValue[] = [];
		const screen = new XSettingsScreen(
			[steering],
			theme,
			(_id, value) => changes.push(value),
			() => {},
			() => {},
		);

		screen.handleInput("l");
		screen.handleInput("h");
		screen.handleInput("\r");
		screen.handleInput("j");
		screen.handleInput("\r");
		screen.handleInput("h");
		screen.handleInput("l");

		expect(changes).toEqual(["all"]);
		expect(stripTerminalSequences(screen.render(100).join("\n"))).toContain("All");
		expect(stripTerminalSequences(screen.render(100).join("\n"))).not.toContain("One at a time");
	});

	test("turns a structured list into an xsettings-owned summary row", () => {
		const definition: SettingDefinition = {
			key: "roles",
			label: "Roles",
			description: "Configure roles.",
			category: "behavior",
			type: "list",
			default: [{ name: "balanced" }],
			schema: Type.Array(Type.Object({ name: Type.String() }), { minItems: 1 }),
			list: {
				itemLabel: "Role",
				identity: "name",
				uniqueIdentity: true,
				summary: [{ path: ["name"] }],
				minItems: 1,
				newItem: { name: "role" },
				fields: [{ key: "name", label: "Name", description: "Role name.", type: "string" }],
			},
		};
		const registration: SettingRegistration = {
			namespace: "pi-model-roles",
			label: "Model Roles",
			definitions: [definition],
		};

		const field = toUiField(
			{ behavior: { "pi-model-roles": { roles: [{ name: "task" }] } } },
			registration,
			definition,
		);

		expect(field).toMatchObject({
			type: "list",
			value: [{ name: "task" }],
		});
		expect(formatSettingValue(field)).toBe("1 role");
	});

	test("turns a string list into an ordered item-count row", () => {
		const definition: SettingDefinition = {
			key: "reactions",
			label: "Reactions",
			description: "Ordered reaction presets.",
			category: "interaction",
			type: "string-list",
			default: ["👍 Looks good"],
			minItems: 1,
		};
		const registration: SettingRegistration = {
			namespace: "pi-annotations",
			label: "Annotations",
			definitions: [definition],
		};

		const field = toUiField(
			{ interaction: { "pi-annotations": { reactions: ["✅ Approved", "❓ Clarify"] } } },
			registration,
			definition,
		);

		expect(field).toMatchObject({
			type: "string-list",
			value: ["✅ Approved", "❓ Clarify"],
			minItems: 1,
		});
		expect(formatSettingValue(field)).toBe("2 items");
	});

	test("refreshes enum choices when their sibling list changes", () => {
		initTheme("dark", false);
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		const defaultRole: SettingsScreenField = {
			id: "extensions.roles.defaultRole",
			label: "Default role",
			description: "Default role name.",
			category: "behavior",
			section: "Roles",
			storagePath: ["behavior", "roles", "defaultRole"],
			type: "enum",
			value: "balanced",
			defaultValue: "balanced",
			configured: false,
			options: [{ value: "balanced", label: "balanced" }],
			optionsFrom: { fieldId: "extensions.roles.roles", itemField: "name" },
		};
		const roles: SettingsScreenField = {
			id: "extensions.roles.roles",
			label: "Roles",
			description: "Ordered roles.",
			category: "behavior",
			section: "Roles",
			storagePath: ["behavior", "roles", "roles"],
			type: "list",
			value: [{ name: "balanced" }],
			defaultValue: [{ name: "balanced" }],
			configured: false,
			schema: Type.Array(Type.Object({ name: Type.String() }), { minItems: 1 }),
			list: {
				itemLabel: "Role",
				identity: "name",
				uniqueIdentity: true,
				summary: [{ path: ["name"] }],
				minItems: 1,
				newItem: { name: "role" },
				fields: [{ key: "name", label: "Name", description: "Role name.", type: "string" }],
			},
		};
		const screen = new XSettingsScreen(
			[defaultRole, roles],
			theme,
			() => {},
			() => {},
			() => {},
			24,
			[],
			roles.id,
		);

		screen.handleInput("\r");
		screen.handleInput("a");
		screen.handleInput("\x13");
		screen.handleInput("j");
		screen.handleInput("\r");

		expect(stripTerminalSequences(screen.render(100).join("\n"))).toContain("role");
	});
});
