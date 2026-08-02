import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import visualExplainer, { openerForPlatform, resolveExplicitOutputPath, writeHtmlAtomically } from "./extension";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function registeredTool() {
  let tool: any;
  visualExplainer({
    registerTool(value: any) {
      tool = value;
    },
    getActiveTools() {
      return [];
    },
    getAllTools() {
      return [];
    },
  } as any);
  return tool;
}


test("explicit paths expand home and preserve the requested filename", () => {
  expect(resolveExplicitOutputPath("~/report", "/tmp/example-home")).toBe("/tmp/example-home/report");
  expect(resolveExplicitOutputPath("report", "/tmp/example-home")).toEndWith("/report");
});

test("Windows opener passes metacharacters without a command shell", () => {
  const path = String.raw`C:\\tmp\\report&notes|draft.html`;
  expect(openerForPlatform(path, "win32")).toEqual({ command: "explorer.exe", args: [path] });
});

test("atomic overwrite preserves the original when commit fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "visual-explainer-"));
  tempDirs.push(dir);
  const outputPath = join(dir, "requested.html");
  writeFileSync(outputPath, "original", "utf8");

  expect(() =>
    writeHtmlAtomically(outputPath, "replacement", true, () => {
      throw new Error("commit failed");
    }),
  ).toThrow("commit failed");
  expect(readFileSync(outputPath, "utf8")).toBe("original");
});
test("render honors outputPath, stays closed, and refuses clobbering", async () => {
  const dir = mkdtempSync(join(tmpdir(), "visual-explainer-"));
  tempDirs.push(dir);
  const outputPath = join(dir, "requested.html");
  const html = "<!doctype html><html><body>ok</body></html>";
  const tool = registeredTool();

  const result = await tool.execute("test", { action: "render", outputPath, html });
  expect(readFileSync(outputPath, "utf8")).toBe(html);
  expect(result.details).toMatchObject({ path: outputPath, openAttempted: false, openStatus: "disabled" });

  await expect(tool.execute("test", { action: "render", outputPath, html })).rejects.toThrow("already exists");
  await tool.execute("test", { action: "render", outputPath, html: html.replace("ok", "updated"), overwrite: true });
  expect(readFileSync(outputPath, "utf8")).toContain("updated");
});

test("render preserves a suffixless explicit output path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "visual-explainer-"));
  tempDirs.push(dir);
  const outputPath = join(dir, "requested");
  const html = "<!doctype html><html><body>ok</body></html>";
  const result = await registeredTool().execute("test", { action: "render", outputPath, html });
  expect(readFileSync(outputPath, "utf8")).toBe(html);
  expect(result.details.path).toBe(outputPath);
});
