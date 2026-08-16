import { getCapabilities } from "@earendil-works/pi-tui";
import { isCodeModeEnabled, setCodeModeEnabled } from "../code-mode/mode.ts";
import { type EditMode, getEditMode, setEditMode } from "../fileops/index.ts";
import { sessionIdFromContext } from "../shared/session-context.ts";
import { toolRegistrarFor } from "../shared/tool-registry.ts";
import { detachToolResultImages } from "../shared/tool-result-images.ts";
import { getToolPolicy } from "../tool-policy/policy.ts";
import type { AgentSettingsRow, AgentSettingsTab } from "./agent-settings-view.ts";
import type { CodexAppServerMcpClient } from "./app-server-mcp.ts";
import { humanizeIdentifier } from "./codex-app-content.ts";
import { codexAppRenderers, showAgentSettingsPanel, showCodexAppsStatus } from "./codex-apps-presentation.ts";
import {
	type CodexAppsConfig,
	type CodexAppsToolRecord,
	type CodexMcpDiscovery,
	type CodexPluginRecord,
	type CodexSkillRecord,
	codexAuthAvailable,
	codexAuthPath,
	codexConfigPath,
	codexMcpWarnings,
	codexToolsStatus,
	createToolDefinition,
	disabledConnectorIds,
	discoverCodexAppsRuntimeState,
	discoverCodexAppsTools,
	discoverCodexPlugins,
	discoverCodexSkills,
	discoverPluginMcpTools,
	enabledCodexAppsTools,
	fetchCodexAppsToolsFromMcp,
	isConnectorEnabled,
	isSkillVisible,
	loadConfig,
	migrateCodexAppsConfig,
	pluginEnabled,
	pluginSkillPaths,
	saveConfig,
	setConnectorEnabled,
	setPluginEnabled,
	setSkillVisible,
	syncCodexPluginAliases,
	systemSkillPaths,
} from "./codex-apps-runtime.ts";
import { discoverConfiguredMcpServers } from "./local-mcp";
import { forgetNodeReplKernel } from "./node-repl-shim.ts";

export * from "./codex-apps-runtime.ts";

let activeMcpClient: CodexAppServerMcpClient | undefined;

const EDIT_MODE_DESCRIPTIONS: Record<EditMode, string> = {
	hashline: "Structured edit protocol and default mode.",
	apply_patch: "Codex patch envelope backed by the forked Rust engine.",
	replace: "Exact text replacement protocol.",
};

function pluginSettingsRows(
	tools: CodexAppsToolRecord[],
	plugins: CodexPluginRecord[],
	skills: CodexSkillRecord[],
	config: CodexAppsConfig,
	persist: () => Promise<void>,
): AgentSettingsRow[] {
	const apps = buildCodexAppRecords(tools, plugins);
	return plugins.map((plugin) => {
		const appCount = apps.filter((app) => app.pluginKey === plugin.key).length;
		const skillCount = skills.filter((skill) => skill.pluginKey === plugin.key).length;
		return {
			id: `plugin:${plugin.key}`,
			label: humanizeIdentifier(plugin.name),
			description: `${plugin.marketplace} · ${plugin.version} · ${appCount} app${appCount === 1 ? "" : "s"} · ${skillCount} skill${skillCount === 1 ? "" : "s"} · ${plugin.rootPath}`,
			value: () => (pluginEnabled(plugin, config) ? "on" : "off"),
			onStep: async () => {
				setPluginEnabled(config, plugin, !pluginEnabled(plugin, config));
				await persist();
			},
		};
	});
}

function appSettingsRows(
	tools: CodexAppsToolRecord[],
	plugins: CodexPluginRecord[],
	config: CodexAppsConfig,
	persist: () => Promise<void>,
): AgentSettingsRow[] {
	const pluginByKey = new Map(plugins.map((plugin) => [plugin.key, plugin]));
	return [
		{
			id: "codex-apps-bridge",
			label: "Codex Apps bridge",
			description: "Controls whether connector tools enter the Code Mode catalog.",
			value: () => (config.enabled ? "on" : "off"),
			onStep: async () => {
				config.enabled = !config.enabled;
				await persist();
			},
		},
		...buildCodexAppRecords(tools, plugins).map((app): AgentSettingsRow => {
			const owner = app.pluginKey ? pluginByKey.get(app.pluginKey) : undefined;
			return {
				id: `app:${app.connectorId}`,
				label: app.connectorName,
				description: `${owner ? `from ${humanizeIdentifier(owner.name)}` : "ChatGPT connector"} · ${app.toolKeys.length} tool${app.toolKeys.length === 1 ? "" : "s"} · ${app.connectorDescription || "Codex app"}`,
				value: () =>
					isConnectorEnabled(app.connectorId, config, disabledConnectorIds(plugins, config)) ? "on" : "off",
				onStep: async () => {
					setConnectorEnabled(
						config,
						app,
						plugins,
						!isConnectorEnabled(app.connectorId, config, disabledConnectorIds(plugins, config)),
					);
					await persist();
				},
			};
		}),
	];
}

function skillSettingsRows(
	plugins: CodexPluginRecord[],
	skills: CodexSkillRecord[],
	config: CodexAppsConfig,
	persist: () => Promise<void>,
): AgentSettingsRow[] {
	const pluginByKey = new Map(plugins.map((plugin) => [plugin.key, plugin]));
	return skills.map((skill) => ({
		id: `skill:${skill.name}`,
		label: skill.name,
		description: `from ${humanizeIdentifier(pluginByKey.get(skill.pluginKey)?.name ?? skill.pluginKey)} · ${skill.filePath}`,
		value: () => (isSkillVisible(skill.name, config) ? "on" : "off"),
		onStep: async () => {
			setSkillVisible(config, skill.name, !isSkillVisible(skill.name, config));
			await persist();
		},
	}));
}

// Core stores returned content by reference. Clone for TUI, then retain images from stored result.
function detachImagesForPresentation(
	result: { content?: unknown[] },
	toolCallId: string | undefined,
): { content: unknown[] } {
	const displayResult = { ...result, content: [...(result.content ?? [])] };
	if (getCapabilities().images) detachToolResultImages(toolCallId, result);
	return displayResult;
}

export default async function registerCodexAppsBridge(pi: ExtensionAPI) {
	forgetNodeReplKernel(activeMcpClient);
	activeMcpClient?.close();
	activeMcpClient = undefined;
	let config = await loadConfig();
	if (migrateCodexAppsConfig(config)) await saveConfig(config);
	let configuredMcpServers = await discoverConfiguredMcpServers();
	const initial = await discoverCodexAppsRuntimeState(config, configuredMcpServers);
	let plugins = initial.plugins;
	let mcpServers = initial.mcpServers;
	let tools = initial.tools;
	let pluginMcp: CodexMcpDiscovery = {
		client: initial.client,
		tools: tools.filter((tool) => Boolean(tool.mcpServerName)),
		servers: mcpServers,
	};
	activeMcpClient = initial.client;
	syncCodexPluginAliases(plugins, config);
	const registeredKeys = new Set<string>();
	const registerConnectorTool = toolRegistrarFor(pi);

	const registerDiscoveredTools = (nextTools: CodexAppsToolRecord[]) => {
		for (const tool of enabledCodexAppsTools(nextTools, plugins, config)) {
			if (registeredKeys.has(tool.key)) continue;
			registeredKeys.add(tool.key);
			const presentation = codexAppRenderers(tool);
			registerConnectorTool({
				...createToolDefinition(
					tool,
					() => config,
					() => pluginMcp.client,
				),
				...presentation,
				renderResult: (result, options, theme, context) =>
					presentation.renderResult(
						detachImagesForPresentation(result, context?.toolCallId),
						options,
						theme,
						context,
					),
			});
		}
	};

	registerDiscoveredTools(tools);

	const notifiedMcpWarnings = new Set<string>();
	const notifyMcpWarnings = (ctx: ExtensionContext) => {
		for (const warning of codexMcpWarnings(mcpServers)) {
			if (notifiedMcpWarnings.has(warning)) continue;
			notifiedMcpWarnings.add(warning);
			ctx.ui.notify(warning, "warning");
		}
	};
	const showStatus = (ctx?: ExtensionContext) => {
		if (ctx) showCodexAppsStatus(ctx, codexToolsStatus(tools, plugins, config, mcpServers));
	};

	const persist = async (nextConfig: CodexAppsConfig) => {
		config = { ...nextConfig };
		await saveConfig(config);
		syncCodexPluginAliases(plugins, config);
	};

	pi.registerCommand("agent-settings", {
		description: "Configure edit mode, Code Mode, and Codex integrations",
		getArgumentCompletions: (prefix: string) => {
			const values = [
				"status",
				"reload",
				"code-mode on",
				"code-mode off",
				"edit hashline",
				"edit apply_patch",
				"edit replace",
			];
			const matches = values.filter((value) => value.startsWith(prefix.trim().toLowerCase()));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const sessionId = sessionIdFromContext(ctx);
			const input = args.trim().toLowerCase();
			if (input === "reload") {
				plugins = await discoverCodexPlugins();
				syncCodexPluginAliases(plugins, config);
				configuredMcpServers = await discoverConfiguredMcpServers();
				pluginMcp.client?.close();
				pluginMcp = await discoverPluginMcpTools(plugins, config, undefined, configuredMcpServers);
				mcpServers = pluginMcp.servers;
				activeMcpClient = pluginMcp.client;
				try {
					tools = [...(await fetchCodexAppsToolsFromMcp(config, ctx.signal)), ...pluginMcp.tools];
					ctx.ui.notify(`Loaded ${tools.length} Codex tools and found ${plugins.length} plugins.`, "info");
				} catch (error) {
					tools = [...(await discoverCodexAppsTools()), ...pluginMcp.tools];
					ctx.ui.notify(
						`Live fetch failed; loaded ${tools.length} cached Codex tools: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				}
				registerDiscoveredTools(tools);
				notifyMcpWarnings(ctx);
				showStatus(ctx);
				await ctx.reload();
				return;
			}

			if (input === "status") {
				ctx.ui.notify(
					[
						`provider   ${ctx.model?.provider ?? "none"}`,
						`model      ${ctx.model?.id ?? "none"}`,
						`auth       ${codexAuthAvailable() ? "available" : "missing"} (${codexAuthPath()})`,
						`catalog    ${codexToolsStatus(tools, plugins, config, mcpServers)}`,
						`sent       ${getToolPolicy(sessionId)?.getActiveToolNames().length ?? 0} tools reach the model`,
						`connector  ${tools.length} Codex App and MCP tools`,
						...(mcpServers.length ? ["", `MCP servers, configured in ${codexConfigPath()}:`] : []),
						...mcpServers.map(
							({ name, configured, appServer }) =>
								`  ${name}  ${
									configured?.enabled === false
										? "off"
										: appServer
											? `${appServer.tools.length} tool${appServer.tools.length === 1 ? "" : "s"}`
											: "unavailable"
								}`,
						),
					].join("\n"),
					"info",
				);
				return;
			}

			if (input.startsWith("code-mode ")) {
				const value = input.slice("code-mode ".length);
				if (value === "on" || value === "off") {
					setCodeModeEnabled(value === "on");
					getToolPolicy(sessionId)?.refreshActiveTools();
					await ctx.reload();
				} else {
					ctx.ui.notify("Usage: /agent-settings code-mode <on|off>", "warning");
				}
				return;
			}

			if (input.startsWith("edit ")) {
				const mode = await setEditMode(input.slice("edit ".length));
				if (!mode) {
					ctx.ui.notify("Usage: /agent-settings edit <apply_patch|hashline|replace>", "warning");
					return;
				}
				await ctx.reload();
				return;
			}

			if (input) {
				ctx.ui.notify(
					"Usage: /agent-settings [status|reload|code-mode <on|off>|edit <apply_patch|hashline|replace>]",
					"warning",
				);
				return;
			}

			const panelConfig = { ...config };
			const skills = discoverCodexSkills(pi.getCommands(), plugins, panelConfig);
			let changed = false;
			const persistPanelConfig = async () => {
				changed = true;
				await persist(panelConfig);
			};
			const tabs: AgentSettingsTab[] = [
				{
					id: "edit",
					label: "Edit",
					hint: "Select the file mutation protocol.",
					rows: () => [
						{
							id: "edit-mode",
							label: "Edit mode",
							get description() {
								return EDIT_MODE_DESCRIPTIONS[getEditMode()];
							},
							value: () => getEditMode(),
							onStep: async (delta) => {
								const modes = Object.keys(EDIT_MODE_DESCRIPTIONS) as EditMode[];
								const next = modes[(modes.indexOf(getEditMode()) + delta + modes.length) % modes.length]!;
								await setEditMode(next);
								changed = true;
							},
						},
					],
				},
				{
					id: "code-mode",
					label: "Code",
					hint: "Control Code Mode availability.",
					rows: () => [
						{
							id: "code-mode-enabled",
							label: "Code Mode",
							description: "Expose the exec tool and nested tool catalog.",
							value: () => (isCodeModeEnabled() ? "on" : "off"),
							onStep: () => {
								setCodeModeEnabled(!isCodeModeEnabled());
								getToolPolicy(sessionId)?.refreshActiveTools();
								changed = true;
							},
						},
					],
				},
				{
					id: "codex",
					label: "Codex",
					hint: "Installed Codex plugins.",
					rows: () => pluginSettingsRows(tools, plugins, skills, panelConfig, persistPanelConfig),
				},
				{
					id: "apps",
					label: "Apps",
					hint: "Control connector tools in the Code Mode catalog.",
					rows: () => appSettingsRows(tools, plugins, panelConfig, persistPanelConfig),
				},
				{
					id: "skills",
					label: "Skills",
					hint: "Control Codex plugin skill visibility.",
					rows: () => skillSettingsRows(plugins, skills, panelConfig, persistPanelConfig),
				},
			];

			await showAgentSettingsPanel(ctx, tabs, (error) =>
				ctx.ui.notify(`Failed to save setting: ${error instanceof Error ? error.message : String(error)}`, "error"),
			);
			showStatus(ctx);
			if (changed) await ctx.reload();
		},
	});

	pi.on("session_start", (_event, ctx) => {
		showStatus(ctx);
		notifyMcpWarnings(ctx);
	});
	pi.on("session_shutdown", () => {
		pluginMcp.client?.close();
		if (activeMcpClient === pluginMcp.client) activeMcpClient = undefined;
	});
	pi.on("resources_discover", async (_event, ctx) => {
		showStatus(ctx);
		return {
			skillPaths: [...(await systemSkillPaths()), ...pluginSkillPaths(plugins, config)],
		};
	});
	pi.on("model_select", (_event, ctx) => showStatus(ctx));
}
