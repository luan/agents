import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

function registeredToolNames(text: string): string[] {
  return [...text.matchAll(/registerTool\(\{\s*name:\s*"([^"]+)"/g)].map(
    (match) => match[1],
  );
}

test("Vault Pi extension exposes only vault-prefixed global tools", () => {
  const names = registeredToolNames(source);

  expect(names).toEqual([
    "vault_create",
    "vault_list",
    "vault_read",
    "vault_archive",
    "vault_prune",
    "vault_comments",
    "vault_rename",
    "vault_retag",
    "vault_related",
    "vault_check",
    "vault_search",
    "vault_status",
    "vault_commit",
  ]);
  expect(names.every((name) => name.startsWith("vault_"))).toBe(true);
  expect(names).not.toContain("project");
  expect(source).not.toContain('name: "project"');
  expect(source).not.toContain("ct project");
});
