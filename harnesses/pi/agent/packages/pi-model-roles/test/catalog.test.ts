import { expect, test } from "bun:test";
import { DEFAULT_MODEL_ROLE_CATALOG, resolveModelRole, roleByName } from "../src/core/catalog.ts";
import { model } from "./fixtures.ts";

test("resolves the first available role candidate with its thinking level", () => {
	const luna = model("gpt-5.6-luna");
	const resolved = resolveModelRole("tiny", DEFAULT_MODEL_ROLE_CATALOG, [luna]);

	expect(resolved?.model).toBe(luna);
	expect(resolved?.candidate.thinking).toBe("low");
	expect(resolved?.role).toBe(roleByName(DEFAULT_MODEL_ROLE_CATALOG, "tiny"));
});

test("falls back to the configured default when a role has no available candidate", () => {
	const sol = model("gpt-5.6-sol");
	const resolved = resolveModelRole("tiny", DEFAULT_MODEL_ROLE_CATALOG, [sol]);

	expect(resolved?.requestedRole).toBe("tiny");
	expect(resolved?.role.name).toBe("balanced");
	expect(resolved?.model).toBe(sol);
});

test("does not select a candidate whose thinking level is unsupported", () => {
	const luna = { ...model("gpt-5.6-luna"), thinkingLevelMap: { low: null } };

	const catalog = { ...DEFAULT_MODEL_ROLE_CATALOG, defaultRole: "tiny" };
	expect(resolveModelRole("tiny", catalog, [luna])).toBeUndefined();
});
