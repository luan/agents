import type { ContextWindowPreset } from "pi-libcontext/sdk";
import type { TuiForegroundColor } from "pi-libtui";
import { createSettings, type SettingDefinitionInput, type SettingsOf } from "pi-xsettings/sdk";

export const CODEX_CONTEXT_WINDOWS: Readonly<Record<ContextWindowPreset, number>> = {
	smart: 180_000,
	balanced: 272_000,
	enhanced: 400_000,
	large: 600_000,
	max: 1_000_000,
};

export const CODEX_CONTEXT_COLORS = {
	smart: { hue: "green", shade: 3 },
	balanced: { hue: "cyan", shade: 3 },
	enhanced: { hue: "blue", shade: 4 },
	large: { hue: "magenta", shade: 4 },
	max: { hue: "red", shade: 5 },
} as const satisfies Readonly<Record<ContextWindowPreset, TuiForegroundColor>>;

export function codexContextWindowLabel(preset: ContextWindowPreset): string {
	return `${preset[0]!.toUpperCase()}${preset.slice(1)} (${CODEX_CONTEXT_WINDOWS[preset] / 1_000}k)`;
}

const definitions = {
	cacheDiagnostics: {
		label: "Cache diagnostics",
		description: "Show Codex cache status or also write private diagnostic logs.",
		category: "behavior",
		type: "enum",
		default: "off",
		options: [
			{ value: "off", label: "Off", description: "Disable cache diagnostics." },
			{ value: "status", label: "Status", description: "Show cache status in the Pi footer." },
			{ value: "status-and-log", label: "Status and log", description: "Show status and write private logs." },
		],
	},
	fallbackCompaction: {
		label: "Fallback compaction",
		description: "Use Pi compaction if native remote compaction fails.",
		category: "behavior",
		type: "boolean",
		default: true,
	},
	fastModeDefault: {
		label: "Fast mode default",
		description: "Start Codex sessions with Fast mode enabled.",
		category: "behavior",
		type: "boolean",
		default: false,
	},
	contextWindowPreset: {
		label: "Context window",
		description: "Default context window for GPT-5.6 Codex models.",
		category: "behavior",
		type: "enum",
		default: "balanced",
		options: [
			{
				value: "smart",
				label: "Smart (180k)",
				description: "Best for short coding tasks in the model's smart zone.",
				color: CODEX_CONTEXT_COLORS.smart,
			},
			{
				value: "balanced",
				label: "Balanced (272k)",
				description: "Codex-preferred default window.",
				color: CODEX_CONTEXT_COLORS.balanced,
			},
			{
				value: "enhanced",
				label: "Enhanced (400k)",
				description: "Large tasks that may finish without compaction.",
				color: CODEX_CONTEXT_COLORS.enhanced,
			},
			{
				value: "large",
				label: "Large (600k)",
				description: "Large projects and long-running orchestration.",
				color: CODEX_CONTEXT_COLORS.large,
			},
			{
				value: "max",
				label: "Max (1M)",
				description: "Maximum context; quality may degrade at this size.",
				color: CODEX_CONTEXT_COLORS.max,
			},
		],
	},
	contextAutoUpgrade: {
		label: "Upgrade context",
		description: "Choose when Codex may upgrade through larger context-window tiers.",
		category: "behavior",
		type: "enum",
		default: "never",
		options: [
			{ value: "never", label: "Never", description: "Auto-compact as soon as the selected tier's threshold is met." },
			{
				value: "mid-turn",
				label: "Mid-turn",
				description: "Upgrade during an active tool turn, then allow compaction when the run ends.",
			},
			{ value: "always", label: "Always", description: "Upgrade through Max, ignoring thresholds on lower tiers." },
		],
	},
	textVerbosity: {
		label: "Text verbosity",
		description: "Set the detail level for Codex text responses.",
		category: "behavior",
		type: "enum",
		default: "low",
		options: [
			{ value: "low", label: "Low", description: "Prefer concise responses." },
			{ value: "medium", label: "Medium", description: "Use a balanced level of detail." },
			{ value: "high", label: "High", description: "Prefer detailed responses." },
		],
	},
} as const satisfies Record<string, SettingDefinitionInput>;

const settings = createSettings({ namespace: "pi-codex-native", label: "Codex Native", definitions });

export type CodexNativeSettings = SettingsOf<typeof definitions>;
export type CacheDiagnosticsMode = CodexNativeSettings["cacheDiagnostics"];
export const DEFAULT_CODEX_NATIVE_SETTINGS: CodexNativeSettings = { ...settings.defaults };
export const getCodexNativeSettings = settings.get;
export const registerCodexNativeXSettings = settings.register;
