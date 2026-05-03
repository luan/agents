import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function briefExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: `${event.systemPrompt}\nMe talk short. No explain. Tool first. Result first. No filler`,
		};
	});
}
