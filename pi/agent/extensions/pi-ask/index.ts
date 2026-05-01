import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerAskTool } from "./src/ask-tool";

export default function askExtension(pi: ExtensionAPI) {
	registerAskTool(pi);
}
