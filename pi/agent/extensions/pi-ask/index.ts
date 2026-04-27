import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAskTool } from "./src/ask-tool.ts";

const extensionDir = dirname(fileURLToPath(import.meta.url));

export default function askExtension(pi: ExtensionAPI) {
	registerAskTool(pi);
	pi.on("resources_discover", () => ({
		skillPaths: [join(extensionDir, "skills")],
	}));
}
