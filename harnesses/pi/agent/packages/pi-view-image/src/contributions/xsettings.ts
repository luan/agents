import { createSettings } from "@luan.sh/pi-xsettings/sdk";
export const imageSettings = createSettings({
	namespace: "pi-view-image",
	label: "View Image",
	definitions: {
		descriptionFallback: {
			category: "tools",
			type: "boolean",
			default: true,
			apply: "live",
			label: "Describe images for text-only models",
			description: "Ask a vision model to describe the image when the active model cannot see it.",
		},
		descriptionModel: {
			category: "tools",
			type: "string",
			default: "openai-codex/gpt-5.6-luna",
			apply: "live",
			label: "Image description model",
			description: "Provider/model used for the additional vision request.",
		},
	},
});
