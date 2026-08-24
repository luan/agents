import { spawn } from "node:child_process";
import type { ViewImageNativeOutput } from "../tools/view-image/result.ts";

const MAX_DIAGNOSTIC_CHARS = 8_192;
// Base64 expands the native image by 4/3. Raise this only with the model input limit.
const MAX_STDOUT_BYTES = 1_431_655_936;

export function parseViewImageOutput(output: string): ViewImageNativeOutput {
	let parsed: object;
	try {
		parsed = JSON.parse(output.trim()) as object;
	} catch (error) {
		throw new Error("view_image returned invalid structured JSON", { cause: error });
	}
	const imageUrl = Reflect.get(parsed, "image_url");
	const detail = Reflect.get(parsed, "detail");
	const path = Reflect.get(parsed, "path");
	const width = Reflect.get(parsed, "width");
	const height = Reflect.get(parsed, "height");
	const bytes = Reflect.get(parsed, "bytes");
	const match = typeof imageUrl === "string" ? imageUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/) : null;
	if (
		!match ||
		(detail !== "high" && detail !== "original") ||
		typeof path !== "string" ||
		typeof width !== "number" ||
		typeof height !== "number" ||
		typeof bytes !== "number"
	) {
		throw new Error("view_image returned an invalid native image attachment");
	}
	return {
		data: match[2]!,
		mimeType: match[1]!,
		detail,
		path,
		width,
		height,
		bytes,
	};
}

export function runViewImageBinary(
	binary: string,
	input: { path: string; detail?: "high" | "original" },
	cwd: string,
	signal?: AbortSignal,
): Promise<ViewImageNativeOutput> {
	return new Promise((resolve, reject) => {
		const child = spawn(binary, ["-"], { cwd, stdio: ["pipe", "pipe", "pipe"], signal });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			callback();
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > MAX_STDOUT_BYTES) {
				child.kill();
				finish(() => reject(new Error(`view_image stdout exceeded ${MAX_STDOUT_BYTES} bytes`)));
			} else stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			if (stderr.length < MAX_DIAGNOSTIC_CHARS + 1) stderr += chunk;
		});
		child.on("error", (error) => finish(() => reject(error)));
		child.on("close", (code) =>
			finish(() => {
				if (code === 0) resolve(parseViewImageOutput(stdout));
				else reject(new Error(stderr.trim().slice(0, MAX_DIAGNOSTIC_CHARS) || `view_image exited with code ${code}`));
			}),
		);
		child.stdin.on("error", (error) => {
			child.kill();
			finish(() => reject(error));
		});
		child.stdin.end(JSON.stringify(input));
	});
}
