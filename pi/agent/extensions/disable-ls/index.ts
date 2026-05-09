import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function arraysEqual(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

export default function disableLsExtension(pi: ExtensionAPI) {
	const removeLs = () => {
		const active = pi.getActiveTools();
		const next = active.filter((toolName) => toolName !== "ls");
		if (!arraysEqual(active, next)) pi.setActiveTools(next);
	};

	pi.on("session_start", removeLs);
	pi.on("session_tree", removeLs);
	pi.on("model_select", removeLs);
	pi.on("before_agent_start", removeLs);
	pi.on("tool_call", (event) => {
		if (event.toolName !== "ls") return;
		return {
			block: true,
			reason: "ls is disabled. Use an available shell command tool instead.",
		};
	});
}
