import type { CodexNativeSettings } from "../contributions/xsettings.ts";

export function timeRemindersEnabled(
	settings: Pick<CodexNativeSettings, "reasoningMode" | "currentTimeReminder">,
): boolean {
	return (
		settings.currentTimeReminder === "on" ||
		(settings.currentTimeReminder === "auto" && settings.reasoningMode === "persistent")
	);
}
export function conversationToolAllowed(
	name: string,
	model: string,
	nonRoot: boolean,
	settings: CodexNativeSettings,
): boolean {
	// The pinned Codex catalog advertises async questions and clock only for Astra.
	const astra = model === "gpt-6-astra";
	const reminders = timeRemindersEnabled(settings);
	switch (name) {
		case "request_user_input_async":
			return !nonRoot && astra;
		case "send_message_to_user_async":
			return !nonRoot && settings.sendMessageToUserAsync;
		case "clock__curr_time":
			return reminders || astra;
		case "clock__sleep":
			return (
				settings.sleepTool &&
				(settings.sleepToolMode === "always_on" ||
					(reminders
						? settings.currentTimeReminderSleep === "on" ||
							(settings.currentTimeReminderSleep === "auto" &&
								settings.currentTimeReminder === "auto" &&
								settings.reasoningMode === "persistent")
						: astra))
			);
		default:
			return true;
	}
}
export function reminderIntervalMilliseconds(seconds: string): bigint {
	if (!/^\d+$/.test(seconds) || BigInt(seconds) > 18446744073709551615n)
		throw new Error("Time reminder interval must be an integer from 0 through 18446744073709551615 seconds");
	return BigInt(seconds) * 1000n;
}
