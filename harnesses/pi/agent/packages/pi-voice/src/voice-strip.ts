import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTuiField, type TuiTheme } from "@luan.sh/pi-libtui";
import type { VoiceController } from "./controller.ts";

export type VoiceStripState = Pick<VoiceController, "status" | "active" | "recording" | "muted" | "activity">;
export interface VoiceStripKeys {
	toggle: string;
	dictate: string;
	mute: string;
}

const bars = "▁▂▃▄▅▆▇█";
function meter(history: readonly number[]): string {
	return history
		.map((level) => bars[Math.round((level / 255) * 7)])
		.join("")
		.padStart(6, "▁");
}

/** Render measured samples without advancing them; editor redraws must not change the meter. */
export function renderVoiceStrip(
	state: VoiceStripState,
	keys: VoiceStripKeys,
	colors: TuiTheme,
	width: number,
): string[] {
	if (state.status === "off" || width < 1) return [];
	const hasLevels = state.activity.microphone.length > 0;
	const ready =
		(hasLevels || ["listening", "speaking", "responding", "recording"].includes(state.status)) &&
		state.status !== "stopping";
	const live = ready && !state.muted && (!state.recording || state.status === "recording");
	const status = state.muted ? "muted" : state.status;
	const marker = colors.fg(live ? "negative" : "text.muted", live ? "●" : "◌");
	const label = state.recording ? "dictation" : "voice";
	const left = `${colors.fg("text.secondary", label)} ${marker} ${colors.fg("text.muted", status)}`;
	const controls = state.recording
		? [...(state.status === "recording" ? [`${keys.dictate} finish`] : []), "esc cancel"]
		: [...(state.active && ready ? [`${keys.mute} ${state.muted ? "unmute" : "mute"}`] : []), `${keys.toggle} stop`];
	const right = controls.join("  ");
	const gap = width - visibleWidth(left) - visibleWidth(right);
	const lines =
		gap >= 2
			? [left + " ".repeat(gap) + colors.fg("text.secondary", right)]
			: [
					truncateToWidth(left, width),
					...(visibleWidth(right) <= width ? [right] : controls).map((line) =>
						colors.fg("text.secondary", truncateToWidth(line, width)),
					),
				];
	if (hasLevels && ready && (!state.recording || state.status === "recording")) {
		const levels = `mic ${meter(state.muted ? [] : state.activity.microphone)}${state.recording ? "" : `  Pi ${meter(state.activity.speaker)}`}`;
		if (visibleWidth(levels) <= width) lines.push(colors.fg("text.muted", levels));
	}
	for (const [role, text] of Object.entries(state.activity.captions)) {
		if (!text) continue;
		const prefix = role === "user" ? "You: " : "Pi: ";
		const available = Math.max(0, width - prefix.length);
		const clean = sanitizeTuiField(text);
		const tail =
			visibleWidth(clean) <= available
				? clean
				: `…${sliceByColumn(clean, Math.max(0, visibleWidth(clean) - available + 1), Math.max(0, available - 1))}`;
		lines.push(colors.fg("text.secondary", truncateToWidth(prefix + tail, width)));
	}
	return lines;
}
