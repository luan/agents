import { createSettings } from "@luan.sh/pi-xsettings/sdk";
export const voiceSettings = createSettings({
	namespace: "pi-voice",
	label: "Voice",
	definitions: {
		v3Voice: {
			category: "behavior",
			type: "enum",
			default: "cove",
			label: "Voice",
			description: "Voice used by the realtime conversation.",
			options: ["cove", "vale", "ember", "breeze", "juniper", "maple", "sol", "spruce", "arbor"].map((value) => ({
				value,
				label: value,
				description: `Use ${value}.`,
			})),
		},
		inputDevice: {
			category: "behavior",
			type: "string",
			default: "",
			label: "Microphone",
			description: "Device ID; empty uses the system default.",
		},
		outputDevice: {
			category: "behavior",
			type: "string",
			default: "",
			label: "Speaker",
			description: "Device ID; empty uses the system default.",
		},
		delegationAcknowledgements: {
			category: "behavior",
			type: "boolean",
			default: true,
			label: "Spoken acknowledgements",
			description: "Allow the voice service to acknowledge requests while Pi begins work.",
		},
		autoResume: {
			category: "behavior",
			type: "boolean",
			default: false,
			label: "Reconnect voice",
			description: "Replace an established call after its transport drops.",
		},
		refreshAfterCompaction: {
			category: "behavior",
			type: "boolean",
			default: true,
			label: "Refresh voice context",
			description: "Refresh the voice call after compaction or context rollover.",
		},
		contextModel: {
			category: "behavior",
			type: "string",
			default: "openai-codex/gpt-5.6-luna",
			label: "Voice context model",
			description: "Provider/model used for isolated conversation summaries.",
		},
	} as const,
});
export interface VoiceConfig {
	voice: ReturnType<typeof voiceSettings.get>;
}
export function getVoiceConfig(): VoiceConfig {
	return { voice: voiceSettings.get() };
}
