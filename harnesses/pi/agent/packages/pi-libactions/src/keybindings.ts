import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

/** Immutable user keybindings indexed by action ID. */
export type ActionKeybindings = Readonly<Record<string, readonly KeyId[]>>;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const BASE_KEYS = new Set([
	..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
	"`",
	"-",
	"=",
	"[",
	"]",
	"\\",
	";",
	"'",
	",",
	".",
	"/",
	"!",
	"@",
	"#",
	"$",
	"%",
	"^",
	"&",
	"*",
	"(",
	")",
	"_",
	"+",
	"|",
	"~",
	"{",
	"}",
	":",
	"<",
	">",
	"?",
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageUp",
	"pageDown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_unused, index) => `f${index + 1}`),
]);
const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

/** Validate one pi-tui key identifier without registering it. */
export function isActionKeyId(value: string): value is KeyId {
	const parts = value.split("+");
	const base = parts.pop();
	if (!base || !BASE_KEYS.has(base)) return false;
	const seen = new Set<string>();
	return parts.every((part) => MODIFIERS.has(part) && !seen.has(part) && Boolean(seen.add(part)));
}

/**
 * Read the user-owned action bindings used by extension action hosts and modal features.
 * Invalid documents, action values, and key identifiers are omitted.
 * @param path Optional keybindings file path; defaults to Pi's active agent directory.
 * @returns A deeply immutable action-to-key snapshot refreshed when extensions reload.
 */
export function loadActionKeybindings(path = join(getAgentDir(), "keybindings.json")): ActionKeybindings {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as JsonValue;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return Object.freeze({});
		const result: Record<string, readonly KeyId[]> = {};
		for (const [action, value] of Object.entries(parsed)) {
			const keys = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
			result[action] = Object.freeze(keys.filter((key): key is KeyId => typeof key === "string" && isActionKeyId(key)));
		}
		return Object.freeze(result);
	} catch {
		return Object.freeze({});
	}
}
