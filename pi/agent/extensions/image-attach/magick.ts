import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Run `magick` over `path` and return its bytes, or undefined when it is missing or fails. */
export async function magickBuffer(path: string, args: string[], maxBufferBytes = 8 * 1024 * 1024) {
	try {
		const { stdout } = await execFileAsync("magick", [path, "-alpha", "remove", "-alpha", "off", ...args], {
			timeout: 8000,
			encoding: "buffer",
			maxBuffer: maxBufferBytes,
		});
		return stdout;
	} catch {
		return undefined;
	}
}
