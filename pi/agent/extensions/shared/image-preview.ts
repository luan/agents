import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PREVIEW_MAX_WIDTH_PX = 720;
const PREVIEW_MAX_HEIGHT_PX = 540;
const PREVIEW_DIR = join(homedir(), ".pi", "agent", "image-previews");

export type PreviewImage = {
	data: string;
	mimeType: "image/png";
	sourcePath?: string;
};

async function magickPreview(inputPath: string): Promise<PreviewImage | undefined> {
	const output = join(PREVIEW_DIR, `${randomUUID()}-${basename(inputPath).replace(/[^A-Za-z0-9._-]/g, "_")}.png`);
	try {
		await mkdir(PREVIEW_DIR, { recursive: true });
		await execFileAsync(
			"magick",
			[inputPath, "-auto-orient", "-resize", `${PREVIEW_MAX_WIDTH_PX}x${PREVIEW_MAX_HEIGHT_PX}>`, "-strip", output],
			{ timeout: 4000 },
		);
		const data = await readFile(output);
		if (data.length === 0) return undefined;
		return { data: data.toString("base64"), mimeType: "image/png", sourcePath: output };
	} catch {
		await rm(output, { force: true }).catch(() => {});
		return undefined;
	}
}

function magickPreviewSync(inputPath: string): PreviewImage | undefined {
	const output = join(PREVIEW_DIR, `${randomUUID()}-${basename(inputPath).replace(/[^A-Za-z0-9._-]/g, "_")}.png`);
	try {
		mkdirSync(PREVIEW_DIR, { recursive: true });
		execFileSync(
			"magick",
			[inputPath, "-auto-orient", "-resize", `${PREVIEW_MAX_WIDTH_PX}x${PREVIEW_MAX_HEIGHT_PX}>`, "-strip", output],
			{ timeout: 4000, stdio: ["ignore", "ignore", "ignore"] },
		);
		const data = readFileSync(output);
		if (data.length === 0) return undefined;
		return { data: data.toString("base64"), mimeType: "image/png", sourcePath: output };
	} catch {
		rmSync(output, { force: true });
		return undefined;
	}
}

function createPreviewImageFromPathSync(path: string): PreviewImage | undefined {
	return magickPreviewSync(path);
}

export function readPreviewImageFromPathSync(path: string): PreviewImage | undefined {
	const preview = createPreviewImageFromPathSync(path);
	if (preview) return preview;
	try {
		return { data: readFileSync(path).toString("base64"), mimeType: "image/png", sourcePath: path };
	} catch {
		return undefined;
	}
}

async function createPreviewImageFromPath(path: string): Promise<PreviewImage | undefined> {
	return magickPreview(path);
}

export async function createPreviewImageFromBase64(data: string, mimeType: string): Promise<PreviewImage | undefined> {
	const dir = join(tmpdir(), `pi-image-preview-${randomUUID()}`);
	const ext = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1] || "img";
	const input = join(dir, `input.${ext}`);
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(input, Buffer.from(data, "base64"));
		return await magickPreview(input);
	} catch {
		return undefined;
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

export async function createCircularPreviewImageFromBase64(
	data: string,
	mimeType: string,
): Promise<PreviewImage | undefined> {
	const dir = join(tmpdir(), `pi-image-avatar-${randomUUID()}`);
	const ext = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1] || "img";
	const input = join(dir, `input.${ext}`);
	const output = join(PREVIEW_DIR, `${randomUUID()}-avatar.png`);
	try {
		await mkdir(dir, { recursive: true });
		await mkdir(PREVIEW_DIR, { recursive: true });
		await writeFile(input, Buffer.from(data, "base64"));
		await execFileAsync(
			"magick",
			[
				input,
				"-auto-orient",
				"-resize",
				"64x64^",
				"-gravity",
				"center",
				"-extent",
				"64x64",
				"(",
				"-size",
				"64x64",
				"xc:black",
				"-fill",
				"white",
				"-draw",
				"circle 32,32 32,0",
				")",
				"-alpha",
				"off",
				"-compose",
				"CopyOpacity",
				"-composite",
				"-strip",
				output,
			],
			{ timeout: 4000 },
		);
		const outputData = await readFile(output);
		if (outputData.length === 0) return undefined;
		return { data: outputData.toString("base64"), mimeType: "image/png", sourcePath: output };
	} catch {
		await rm(output, { force: true }).catch(() => {});
		return undefined;
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

export async function readPreviewImageFromPath(path: string): Promise<PreviewImage | undefined> {
	const preview = await createPreviewImageFromPath(path);
	if (preview) return preview;
	try {
		return { data: (await readFile(path)).toString("base64"), mimeType: "image/png", sourcePath: path };
	} catch {
		return undefined;
	}
}
