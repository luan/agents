import { expect, it } from "bun:test";
import { RustCellKernel, rustSource } from "./rust-kernel.ts";

const fourCallSource = [
	"const [a,b,c,d]=await Promise.all([",
	' tools.search({pattern:"registerCommand\\\\(\\"codex\\"|Voice \\\\(later\\\\)|Code Mode runtime|Edit mode",path:"pi/agent/extensions",glob:"*.ts",limit:100,context:2}),',
	' tools.find({paths:["pi/agent/extensions/**/*token*burden*","pi/agent/extensions/**/*settings*.ts","pi/agent/extensions/codex-native/**"],limit:200}),',
	' tools.search({pattern:"token burden|Token burden|token-burden|burden",path:"pi/agent/extensions",glob:"*.ts",limit:100,ignoreCase:true,context:2}),',
	' tools.exec_command({cmd:"git diff --stat && git status --short",workdir:"/workspace",yield_time_ms:10000,max_output_tokens:12000})',
	// biome-ignore lint/suspicious/noTemplateCurlyInString: exact regression source must retain runtime interpolation.
	"]);text(`--- command ---\\n${a.text}\\n--- files ---\\n${b.text}\\n--- token burden ---\\n${c.text}\\n--- git ---\\n${d.stdout??d.text}`);",
].join("\n");

it("strips narrow TypeScript syntax before Rust execution", () => {
	expect(rustSource('const value: string = "ok"; text(value);')).not.toContain(": string");
});

it("keeps the four-call template-literal cell syntactically valid", () => {
	const transformed = rustSource(fourCallSource);
	expect(() => new Function("tools", "text", `return (async () => { ${transformed} })();`)).not.toThrow();
	expect(transformed).toMatch(/context:\s*2/);
});

it("does not leak an unhandled rejection when an active cell is interrupted", async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (error: unknown) => unhandled.push(error);
	process.on("unhandledRejection", onUnhandled);
	const kernel = new RustCellKernel(undefined, { callTool: async () => ({ text: "" }), notify() {} });
	const controller = new AbortController();
	try {
		const result = kernel.run(90, "await new Promise(() => {})", [], controller.signal);
		setTimeout(() => controller.abort(), 100);
		await expect(result).rejects.toThrow("cell 90 interrupted");
		await Bun.sleep(20);
		expect(unhandled).toEqual([]);
	} finally {
		process.off("unhandledRejection", onUnhandled);
		kernel.reset();
	}
});
