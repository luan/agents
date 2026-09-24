import { createSettings } from "@luan.sh/pi-xsettings/sdk";
export const contextSettings = createSettings({
	namespace: "pi-context-windows",
	label: "Context Windows",
	definitions: {
		hybrid: {
			category: "behavior",
			type: "boolean",
			default: false,
			apply: "live",
			label: "Generated recovery summaries",
			description:
				"Generate a cumulative readable summary alongside notes, plus a native provider checkpoint when supported. Adds summarization and checkpoint requests.",
		},
		archiveMode: {
			category: "behavior",
			type: "enum",
			default: "local",
			apply: "live",
			label: "Context archives",
			description: "Keep windows in the active branch or archive completed windows as Pi side branches.",
			options: [
				{ value: "local", label: "Local", description: "Project windows from the current branch." },
				{ value: "tree", label: "Tree", description: "Archive completed windows as navigable branches." },
			],
		},
	},
});
