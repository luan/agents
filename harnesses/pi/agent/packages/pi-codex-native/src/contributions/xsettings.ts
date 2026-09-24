import type { TuiForegroundColor } from "@luan.sh/pi-libtui";
import { createSettings, type SettingDefinitionInput, type SettingsOf } from "@luan.sh/pi-xsettings/sdk";
import type { ContextWindowPreset } from "../protocol/context-window.ts";

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
	portableCompaction: {
		category: "behavior",
		type: "boolean",
		default: false,
		apply: "live",
		label: "Portable compaction summary",
		description:
			"Generate a readable Pi summary beside each encrypted Codex checkpoint for provider switching. Adds a summarization request.",
	},
	lunaReserve: {
		label: "Luna Reserve",
		description:
			"After quota exhaustion, switch only when the backend authorizes Reserve. Wait for your next input; restore the original model when ordinary quota returns.",
		category: "behavior",
		type: "boolean",
		default: true,
		apply: "live",
	},
	autoReasoning: {
		label: "Auto reasoning (Astra)",
		description:
			"Let Astra adjust effort by work phase, never below your starting level; restore it when the run ends.",
		category: "tools",
		type: "boolean",
		default: false,
		apply: "live",
	},
	reasoningMode: {
		scope: "session",
		apply: "live",
		label: "Reasoning mode (this session)",
		description: "Use Pi's selected thinking level, or Codex Persistent reasoning with its follow-up instructions.",
		category: "behavior",
		type: "enum",
		default: "pi",
		options: [
			{ value: "pi", label: "Use Pi thinking level", description: "Keep the session's normal reasoning effort." },
			{
				value: "persistent",
				label: "Persistent",
				description: "Codex Persistent reasoning; async tools remain independent.",
			},
		],
	},
	currentTimeReminder: {
		apply: "live",
		label: "Current time reminders",
		description: "Supply the current UTC time to Codex. Auto enables reminders with Persistent reasoning.",
		category: "behavior",
		type: "enum",
		default: "auto",
		options: [
			{ value: "auto", label: "Auto", description: "Use Codex Persistent defaults." },
			{ value: "on", label: "On", description: "Include time independently of reasoning mode." },
			{ value: "off", label: "Off", description: "Disable reminders, including in Persistent mode." },
		],
	},
	currentTimeReminderIntervalSeconds: {
		label: "Time reminder interval (seconds)",
		description:
			"Non-negative integer seconds between reminders. Zero supplies a reminder before every eligible inference.",
		category: "behavior",
		type: "string",
		default: "1",
		apply: "live",
	},
	currentTimeReminderDelivery: {
		label: "Time reminder delivery",
		description: "Choose which inference boundaries can receive a reminder; a new context always receives one.",
		category: "behavior",
		type: "enum",
		default: "any_inference",
		apply: "live",
		options: [
			{ value: "any_inference", label: "Any inference", description: "Deliver whenever the interval is due." },
			{
				value: "after_user_or_tool_output",
				label: "After user or tool output",
				description: "Require new user input or tool output.",
			},
		],
	},
	currentTimeReminderSleep: {
		label: "Sleep with time reminders",
		description: "Auto enables sleep with Persistent defaults. On and Off explicitly override it.",
		category: "behavior",
		type: "enum",
		default: "auto",
		apply: "live",
		options: [
			{ value: "auto", label: "Auto", description: "Use Codex defaults." },
			{ value: "on", label: "On", description: "Expose sleep with reminders." },
			{ value: "off", label: "Off", description: "Do not expose sleep through reminders." },
		],
	},
	sleepTool: {
		label: "Sleep tool",
		description: "Enable the interruptible sleep feature independently of Persistent.",
		category: "tools",
		type: "boolean",
		default: true,
		apply: "live",
	},
	sleepToolMode: {
		label: "Sleep tool availability",
		description: "Use model and reminder settings, or expose sleep on every model.",
		category: "tools",
		type: "enum",
		default: "model_driven",
		apply: "live",
		options: [
			{ value: "model_driven", label: "Model driven", description: "Use the model catalog and reminder settings." },
			{ value: "always_on", label: "Always on", description: "Expose sleep whenever its feature is enabled." },
		],
	},
	sendMessageToUserAsync: {
		label: "Async messages",
		description: "Enable async user messages even when the model catalog does not advertise them. Root agents only.",
		category: "tools",
		type: "boolean",
		default: false,
		apply: "live",
	},
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
		description: "Default context window for GPT-5.6 and GPT-6 Astra Codex models.",
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
