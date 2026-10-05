import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installTranscriptHistory, mountTranscriptProjection, retainTranscriptHistory } from "@luan.sh/pi-libtui/tool";
import { ActivityTimings } from "./activity-timing.ts";
import { ActivityTranscript } from "./activity-transcript.ts";

export default function transcriptExtension(pi: ExtensionAPI): void {
	const releasePreparation = retainTranscriptHistory();
	let unmount: (() => void) | undefined;
	let transcript: ActivityTranscript | undefined;
	pi.on("agent_start", () => transcript?.beginTurn());
	pi.on("agent_settled", () => transcript?.finishTurn());
	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "user") return;
		const previous = ctx.sessionManager
			.getBranch()
			.filter(
				(entry) => entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "user"),
			)
			.at(-1);
		if (previous?.type !== "message" || previous.message.role !== "assistant" || previous.message.stopReason !== "stop")
			return;
		// Queued requests can follow a final answer without agent_settled between them.
		transcript?.finishTurn();
		transcript?.beginTurn();
	});
	pi.on("session_start", (_event, ctx) => {
		unmount?.();
		unmount = undefined;
		transcript = undefined;
		if (!ctx.hasUI || ctx.mode !== "tui") {
			releasePreparation();
			return;
		}
		ctx.ui.setWidget("pi-collapse-transcript.host", (tui, theme) => {
			unmount?.();
			const releaseHistory = installTranscriptHistory(tui);
			releasePreparation();
			const timings = new ActivityTimings();
			let previousLeaf: string | null | undefined;
			const release = mountTranscriptProjection(tui, (entries) => {
				transcript = new ActivityTranscript(
					() => {
						const leaf = ctx.sessionManager.getLeafId();
						if (leaf !== previousLeaf) {
							timings.load(ctx.sessionManager.getBranch());
							previousLeaf = leaf;
						}
						return entries();
					},
					theme,
					() => tui.requestRender(),
					timings,
				);
				return transcript;
			});
			const dispose = () => {
				release?.();
				releaseHistory();
			};
			unmount = dispose;
			return {
				render: () => [],
				invalidate() {},
				dispose: () => {
					dispose();
					if (unmount === dispose) unmount = undefined;
				},
			};
		});
	});
	pi.on("session_shutdown", (_event, ctx) => {
		releasePreparation();
		unmount?.();
		unmount = undefined;
		transcript = undefined;
		if (ctx.hasUI && ctx.mode === "tui") ctx.ui.setWidget("pi-collapse-transcript.host", undefined);
	});
}
