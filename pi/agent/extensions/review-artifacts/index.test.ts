import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import reviewArtifactsExtension, {
	buildImageReviewHtml,
	createImageReviewArtifact,
	resetStartAnnotationSessionForTests,
	resolveHtmlReviewTarget,
	setStartAnnotationSessionForTests,
} from "./index";

describe("review artifact helpers", () => {
	test("resolves html files and rejects non-html targets", () => {
		const dir = mkdtempSync(join(tmpdir(), "review-html-"));
		const htmlPath = join(dir, "mock.html");
		const mdPath = join(dir, "mock.md");
		writeFileSync(htmlPath, "<html></html>");
		writeFileSync(mdPath, "# nope\n");
		expect(resolveHtmlReviewTarget("mock.html", dir)).toBe(htmlPath);
		expect(() => resolveHtmlReviewTarget("mock.md", dir)).toThrow(".html or .htm");
		rmSync(dir, { recursive: true, force: true });
	});

	test("builds html image gallery entries", () => {
		const html = buildImageReviewHtml("/tmp/screens", ["/tmp/screens/a.png", "/tmp/screens/sub/b.jpg"]);
		expect(html).toContain("<!doctype html>");
		expect(html).toContain("<h1>screens</h1>");
		expect(html).toContain("<h2>a.png</h2>");
		expect(html).toContain("<h2>sub/b.jpg</h2>");
		expect(html).toContain('<img alt="a.png" src="./api/image?path=%2Ftmp%2Fscreens%2Fa.png"');
	});

	test("creates an html review artifact for folder images", () => {
		const dir = mkdtempSync(join(tmpdir(), "review-images-"));
		const nested = join(dir, "nested");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(dir, "a.png"), "png");
		writeFileSync(join(nested, "b.jpg"), "jpg");
		const { reviewPath, rawHtml, imagePaths } = createImageReviewArtifact(dir);
		expect(imagePaths).toEqual([join(dir, "a.png"), join(nested, "b.jpg")]);
		const reviewHtml = readFileSync(reviewPath, "utf-8");
		expect(reviewPath.endsWith(".html")).toBe(true);
		expect(reviewPath).toMatch(/\/review-images-[^/]+\/review-images-[^/]+\.html$/);
		expect(reviewHtml).toContain("Image count");
		expect(reviewHtml).toContain("<h2>nested/b.jpg</h2>");
		expect(rawHtml).toContain("<h2>a.png</h2>");
		rmSync(dir, { recursive: true, force: true });
	});

	test("creates an html review artifact for a single image file", () => {
		const dir = mkdtempSync(join(tmpdir(), "review-image-single-"));
		const imagePath = join(dir, "hero.png");
		writeFileSync(imagePath, "png");
		const { rawHtml, imagePaths } = createImageReviewArtifact(imagePath);
		expect(imagePaths).toEqual([imagePath]);
		expect(rawHtml).toContain("Source image");
		expect(rawHtml).toContain("<h2>hero.png</h2>");
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("review artifact extension registration", () => {
	const createdPaths: string[] = [];

	afterEach(() => {
		for (const path of createdPaths.splice(0)) {
			rmSync(path, { recursive: true, force: true });
		}
		resetStartAnnotationSessionForTests();
	});

	test("registers commands and tools", () => {
		const commands: string[] = [];
		const tools: string[] = [];
		reviewArtifactsExtension({
			registerCommand(name: string) {
				commands.push(name);
			},
			registerTool(tool: { name: string }) {
				tools.push(tool.name);
			},
		} as any);
		expect(commands.sort()).toEqual(["review-html", "review-images"]);
		expect(tools.sort()).toEqual(["review_html", "review_images"]);
	});

	test("opens html review through the plannotator annotation helper", async () => {
		const dir = mkdtempSync(join(tmpdir(), "review-html-tool-"));
		createdPaths.push(dir);
		const htmlPath = join(dir, "mock.html");
		writeFileSync(htmlPath, "<html><body><h1>Mock</h1></body></html>");

		const tools: any[] = [];
		const calls: any[][] = [];
		setStartAnnotationSessionForTests(async (...args: any[]) => {
			calls.push(args);
			return {
				waitForDecision: async () => ({ approved: true }),
			} as any;
		});
		reviewArtifactsExtension({
			registerCommand() {},
			registerTool(tool: any) {
				tools.push(tool);
			},
		} as any);

		const tool = tools.find((entry) => entry.name === "review_html");
		const result = await tool.execute("1", { targetPath: htmlPath }, undefined, undefined, {
			cwd: dir,
			hasUI: true,
			ui: { notify() {}, confirm: async () => false },
		});

		expect(result.content[0].text).toContain("HTML review completed");
		expect(calls).toHaveLength(1);
		expect(calls[0][1]).toBe(htmlPath);
		expect(calls[0][2]).toBe("");
		expect(calls[0][7]).toBe(true);
		expect(calls[0][8]).toContain("<h1>Mock</h1>");
		expect(calls[0][9]).toBe(true);
	});

	test("offers optional screenshot review after direct html review", async () => {
		const dir = mkdtempSync(join(tmpdir(), "review-html-screens-tool-"));
		createdPaths.push(dir);
		const htmlPath = join(dir, "mock.html");
		writeFileSync(htmlPath, "<html><body><h1>Mock</h1></body></html>");

		const tools: any[] = [];
		const calls: any[][] = [];
		setStartAnnotationSessionForTests(async (...args: any[]) => {
			calls.push(args);
			return {
				waitForDecision: async () => ({ approved: true }),
			} as any;
		});
		reviewArtifactsExtension({
			registerCommand() {},
			registerTool(tool: any) {
				tools.push(tool);
			},
			async exec(_command: string, args: string[]) {
				const screenshotArg = args.find((entry) => entry.startsWith("--screenshot="));
				if (screenshotArg) writeFileSync(screenshotArg.slice("--screenshot=".length), "png");
				return { exitCode: 0, stdout: "ok", stderr: "" };
			},
		} as any);

		const tool = tools.find((entry) => entry.name === "review_html");
		const result = await tool.execute("1", { targetPath: htmlPath }, undefined, undefined, {
			cwd: dir,
			hasUI: true,
			ui: { notify() {}, confirm: async () => true },
		});

		expect(result.content[0].text).toContain("Screenshot review also completed");
		expect(calls).toHaveLength(2);
		expect(calls[0][1]).toBe(htmlPath);
		expect(calls[0][8]).toContain("<h1>Mock</h1>");
		expect(calls[1][1]).toContain("/mock-screenshots.html");
		expect(calls[1][8]).toContain("desktop.png");
		expect(calls[1][8]).toContain("mobile.png");
		expect(calls[1][8]).toContain("<h1>mock.html screenshots</h1>");
		expect(calls[1][9]).toBe(true);
	});

	test("opens folder image review directly from the tool", async () => {
		const dir = mkdtempSync(join(tmpdir(), "review-images-tool-"));
		createdPaths.push(dir);
		writeFileSync(join(dir, "one.png"), "png");

		const tools: any[] = [];
		const calls: any[][] = [];
		setStartAnnotationSessionForTests(async (...args: any[]) => {
			calls.push(args);
			return {
				waitForDecision: async () => ({ approved: true }),
			} as any;
		});
		reviewArtifactsExtension({
			registerCommand() {},
			registerTool(tool: any) {
				tools.push(tool);
			},
		} as any);

		const tool = tools.find((entry) => entry.name === "review_images");
		const result = await tool.execute("1", { targetPath: dir }, undefined, undefined, {
			cwd: dir,
			hasUI: true,
			ui: { notify() {} },
		});

		expect(result.content[0].text).toContain("Image review completed");
		expect(calls).toHaveLength(1);
		expect(calls[0][1]).toEndWith(".html");
		expect(calls[0][8]).toContain("one.png");
		expect(calls[0][9]).toBe(true);
	});

	test("opens single-image review directly from the tool", async () => {
		const dir = mkdtempSync(join(tmpdir(), "review-image-tool-"));
		createdPaths.push(dir);
		const imagePath = join(dir, "one.png");
		writeFileSync(imagePath, "png");

		const tools: any[] = [];
		const calls: any[][] = [];
		setStartAnnotationSessionForTests(async (...args: any[]) => {
			calls.push(args);
			return {
				waitForDecision: async () => ({ approved: true }),
			} as any;
		});
		reviewArtifactsExtension({
			registerCommand() {},
			registerTool(tool: any) {
				tools.push(tool);
			},
		} as any);

		const tool = tools.find((entry) => entry.name === "review_images");
		const result = await tool.execute("1", { targetPath: imagePath }, undefined, undefined, {
			cwd: dir,
			hasUI: true,
			ui: { notify() {} },
		});

		expect(result.content[0].text).toContain("Image review completed");
		expect(calls).toHaveLength(1);
		expect(calls[0][8]).toContain("Source image");
		expect(calls[0][8]).toContain("<h2>one.png</h2>");
	});
});
