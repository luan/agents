import type { ExtensionAPI, ExtensionCommandContext, ToolInfo, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import {
	DYNAMIC_TOOLS_CONFIG_PATH,
	type DynamicToolConditions,
	type DynamicToolPredicate,
	type DynamicToolRule,
	type DynamicToolsConfig,
	evaluateDynamicToolRules,
	loadDynamicToolsConfig,
	managedDynamicTools,
	saveDynamicToolsConfig,
	validateDynamicToolDag,
} from "./core.ts";

interface ToolChoice {
	name: string;
	description?: string;
	active: boolean;
}

function arraysEqual(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function setRuleEnabled(config: DynamicToolsConfig, ruleId: string, enabled: boolean): DynamicToolsConfig {
	return {
		...config,
		rules: config.rules.map((rule) => (rule.id === ruleId ? { ...rule, enabled } : rule)),
	};
}

function conditionSummary(conditions: DynamicToolConditions | undefined): string {
	const parts = [];
	if (conditions?.input?.length) parts.push(`input:${conditions.input.length}`);
	if (conditions?.result?.length) parts.push(`result:${conditions.result.length}`);
	return parts.join(" ") || "always";
}

function buildConditions(input: DynamicToolPredicate[] | undefined, result: DynamicToolPredicate[] | undefined) {
	return input || result ? { input, result } : undefined;
}

function defaultRuleId(from: string, to: string[]): string {
	return [from, ...to]
		.join("-")
		.replace(/[^a-zA-Z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function ruleDescription(rule: DynamicToolRule): string {
	const flags = [
		rule.enabled ? "enabled" : "disabled",
		`when ${conditionSummary(rule.when)}`,
		rule.freshRun ? "fresh run" : undefined,
	].filter(Boolean);
	return flags.join(" | ");
}

function collectToolChoices(pi: ExtensionAPI, config: DynamicToolsConfig): ToolChoice[] {
	const active = new Set(pi.getActiveTools());
	const toolInfo = new Map(pi.getAllTools?.().map((tool) => [tool.name, tool]) ?? []);
	const names = new Set<string>([
		...toolInfo.keys(),
		...active,
		...config.roots,
		...config.rules.flatMap((rule) => [rule.from, ...rule.to]),
	]);
	return [...names]
		.sort((left, right) => {
			const activeDelta = Number(active.has(right)) - Number(active.has(left));
			return activeDelta || left.localeCompare(right);
		})
		.map((name) => ({
			name,
			description: toolInfo.get(name)?.description,
			active: active.has(name),
		}));
}

function describeTool(choice: ToolChoice): string {
	const state = choice.active ? "active" : "inactive";
	return choice.description ? `${state} | ${choice.description}` : state;
}

function handleLocalSelectInput(selectList: SelectList, items: SelectItem[], data: string): void {
	if (data === "j" || data === "k") {
		const current = selectList.getSelectedItem();
		const currentIndex = Math.max(0, current ? items.findIndex((item) => item.value === current.value) : 0);
		const nextIndex =
			data === "j" ? (currentIndex + 1) % items.length : (currentIndex - 1 + items.length) % items.length;
		selectList.setSelectedIndex(nextIndex);
		return;
	}
	if (data === "l") {
		const selected = selectList.getSelectedItem();
		if (selected) selectList.onSelect?.(selected);
		return;
	}
	if (data === "h") {
		selectList.onCancel?.();
		return;
	}
	selectList.handleInput(data);
}

async function selectItem(
	ctx: ExtensionCommandContext,
	title: string,
	items: SelectItem[],
	emptyMessage = "Nothing to select",
): Promise<string | undefined> {
	if (items.length === 0) {
		ctx.ui.notify(emptyMessage, "warning");
		return undefined;
	}
	return await ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		container.addChild(new Text("", 0, 0));
		const selectList = new SelectList(items, Math.min(items.length, 18), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(undefined);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "j/k or arrows move | l/enter select | h/esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				handleLocalSelectInput(selectList, items, data);
				tui.requestRender();
			},
		};
	});
}

async function pickTool(
	ctx: ExtensionCommandContext,
	title: string,
	tools: ToolChoice[],
	selectedTool?: string,
): Promise<string | undefined> {
	const choices =
		selectedTool && !tools.some((tool) => tool.name === selectedTool)
			? [{ name: selectedTool, active: false }, ...tools]
			: tools;
	return await selectItem(
		ctx,
		title,
		choices.map((tool) => ({
			value: tool.name,
			label: tool.name === selectedTool ? `* ${tool.name}` : tool.name,
			description: describeTool(tool),
		})),
		"No tools are available in the current context",
	);
}

async function pickToolSet(
	ctx: ExtensionCommandContext,
	title: string,
	tools: ToolChoice[],
	initial: string[],
): Promise<string[] | undefined> {
	const selected = new Set(initial);
	let keepOpen = true;
	while (keepOpen) {
		const choices = [...tools];
		for (const name of selected) {
			if (!choices.some((tool) => tool.name === name)) choices.unshift({ name, active: false });
		}
		const action = await selectItem(
			ctx,
			title,
			[
				{ value: "done", label: "Done", description: `${selected.size} selected` },
				{ value: "clear", label: "Clear selection", description: "Remove all selected child tools" },
				...choices.map((tool) => ({
					value: `tool:${tool.name}`,
					label: `${selected.has(tool.name) ? "[x]" : "[ ]"} ${tool.name}`,
					description: describeTool(tool),
				})),
			],
			"No tools are available in the current context",
		);
		if (!action) return undefined;
		if (action === "done") {
			keepOpen = false;
		} else if (action === "clear") {
			selected.clear();
		} else if (action.startsWith("tool:")) {
			const toolName = action.slice("tool:".length);
			if (selected.has(toolName)) selected.delete(toolName);
			else selected.add(toolName);
		}
	}
	return [...selected];
}

function toolSchemaPaths(tool: ToolInfo | undefined): string[] {
	return schemaPaths(tool?.parameters);
}

function schemaPaths(schema: unknown, prefix = ""): string[] {
	if (!schema || typeof schema !== "object") return [];
	const record = schema as Record<string, unknown>;
	const properties = record.properties;
	if (!properties || typeof properties !== "object") return [];
	const paths: string[] = [];
	for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
		const path = prefix ? `${prefix}.${key}` : key;
		paths.push(path);
		paths.push(...schemaPaths(value, path));
	}
	return paths;
}

function uniquePaths(...pathGroups: (string[] | undefined)[]): string[] {
	return [...new Set(pathGroups.flatMap((paths) => paths ?? []).filter(Boolean))].sort();
}

function predicateLabel(predicate: DynamicToolPredicate): string {
	if (predicate.exists !== undefined) return `${predicate.path} exists ${String(predicate.exists)}`;
	if (predicate.truthy !== undefined) return `${predicate.path} truthy ${String(predicate.truthy)}`;
	if ("equals" in predicate) return `${predicate.path} equals ${JSON.stringify(predicate.equals)}`;
	if (predicate.matches !== undefined) return `${predicate.path} matches /${predicate.matches}/`;
	return predicate.path;
}

function predicateFromChoice(path: string, operator: string): DynamicToolPredicate {
	switch (operator) {
		case "exists:true":
			return { path, exists: true };
		case "exists:false":
			return { path, exists: false };
		case "truthy:true":
			return { path, truthy: true };
		case "truthy:false":
			return { path, truthy: false };
		case "equals:true":
			return { path, equals: true };
		case "equals:false":
			return { path, equals: false };
		case "equals:null":
			return { path, equals: null };
		case "equals:0":
			return { path, equals: 0 };
		case "equals:1":
			return { path, equals: 1 };
		default:
			return { path, exists: true };
	}
}

async function editPredicateSet(
	ctx: ExtensionCommandContext,
	title: string,
	availablePaths: string[],
	initial: DynamicToolPredicate[] | undefined,
): Promise<DynamicToolPredicate[] | undefined> {
	const predicates = [...(initial ?? [])];
	let keepOpen = true;
	while (keepOpen) {
		const action = await selectItem(ctx, title, [
			{ value: "done", label: "Done", description: `${predicates.length} predicates` },
			{ value: "add", label: "Add predicate", description: availablePaths.join(", ") || "No known paths" },
			{ value: "clear", label: "Clear predicates" },
			...predicates.map((predicate, index) => ({
				value: `delete:${index}`,
				label: `Delete ${predicateLabel(predicate)}`,
			})),
		]);
		if (!action) return undefined;
		if (action === "done") {
			keepOpen = false;
		} else if (action === "clear") {
			predicates.length = 0;
		} else if (action === "add") {
			const path = await selectItem(
				ctx,
				`${title}: path`,
				availablePaths.map((value) => ({ value, label: value })),
				"No known paths for this tool",
			);
			if (!path) continue;
			const operator = await selectItem(ctx, `${title}: ${path}`, [
				{ value: "exists:true", label: "exists true" },
				{ value: "exists:false", label: "exists false" },
				{ value: "truthy:true", label: "truthy true" },
				{ value: "truthy:false", label: "truthy false" },
				{ value: "equals:true", label: "equals true" },
				{ value: "equals:false", label: "equals false" },
				{ value: "equals:null", label: "equals null" },
				{ value: "equals:0", label: "equals 0" },
				{ value: "equals:1", label: "equals 1" },
			]);
			if (operator) predicates.push(predicateFromChoice(path, operator));
		} else if (action.startsWith("delete:")) {
			predicates.splice(Number(action.slice("delete:".length)), 1);
		}
	}
	return predicates.length > 0 ? predicates : undefined;
}

async function editConditions(
	ctx: ExtensionCommandContext,
	existing: DynamicToolConditions | undefined,
	inputPaths: string[],
	resultPaths: string[],
): Promise<DynamicToolConditions | undefined | "cancelled"> {
	let input = existing?.input;
	let result = existing?.result;
	let keepOpen = true;
	while (keepOpen) {
		const action = await selectItem(ctx, "Activation conditions", [
			{ value: "done", label: "Done", description: conditionSummary(buildConditions(input, result)) },
			{ value: "always", label: "Always activate", description: "Clear all predicates" },
			{ value: "input", label: "Input predicates", description: `${input?.length ?? 0} predicates` },
			{ value: "result", label: "Result predicates", description: `${result?.length ?? 0} predicates` },
		]);
		if (!action) return "cancelled";
		if (action === "done") {
			keepOpen = false;
		} else if (action === "always") {
			input = undefined;
			result = undefined;
		} else if (action === "input") {
			const edited = await editPredicateSet(ctx, "Input predicates", inputPaths, input);
			if (edited !== undefined || input?.length) input = edited;
		} else if (action === "result") {
			const edited = await editPredicateSet(ctx, "Result predicates", resultPaths, result);
			if (edited !== undefined || result?.length) result = edited;
		}
	}
	return buildConditions(input, result);
}

async function promptForRule(
	ctx: ExtensionCommandContext,
	tools: ToolChoice[],
	toolInfoByName: Map<string, ToolInfo>,
	existing?: DynamicToolRule,
): Promise<DynamicToolRule | undefined> {
	const from = await pickTool(ctx, "Parent tool", tools, existing?.from);
	if (!from) return undefined;

	const to = await pickToolSet(
		ctx,
		`Child tools activated by ${from}`,
		tools.filter((tool) => tool.name !== from),
		existing?.to ?? [],
	);
	if (!to) return undefined;
	if (to.length === 0) {
		ctx.ui.notify("Rule must activate at least one child tool", "error");
		return undefined;
	}

	const id = existing?.id ?? defaultRuleId(from, to);
	const enabledChoice = await selectItem(ctx, "Rule state", [
		{ value: "enabled", label: "Enabled" },
		{ value: "disabled", label: "Disabled" },
	]);
	if (!enabledChoice) return undefined;
	const enabled = enabledChoice === "enabled";
	const freshRunChoice = await selectItem(ctx, "Fresh run after activation", [
		{
			value: "yes",
			label: "Yes",
			description: "End the current tool loop and send a continuation so the new tools are visible immediately",
		},
		{ value: "no", label: "No" },
	]);
	if (!freshRunChoice) return undefined;
	const freshRun = freshRunChoice === "yes";
	const continuation = freshRun
		? await ctx.ui.editor(
				"Continuation prompt",
				existing?.continuation ?? `Continue after ${from}. Newly available tools: ${to.join(", ")}.`,
			)
		: undefined;

	const inputPaths = uniquePaths(
		toolSchemaPaths(toolInfoByName.get(from)),
		existing?.when?.input?.map((item) => item.path),
	);
	const resultPaths = uniquePaths(
		["session_id", "exit_code", "status", "success", "error", "stdout", "stderr"],
		existing?.when?.result?.map((item) => item.path),
	);
	const when = await editConditions(ctx, existing?.when, inputPaths, resultPaths);
	if (when === "cancelled") return undefined;

	return {
		id,
		from,
		to,
		enabled,
		when,
		freshRun,
		continuation: continuation?.trim() || undefined,
	};
}

function reportDiagnostics(ctx: ExtensionCommandContext, diagnostics: string[]): void {
	if (diagnostics.length > 0) ctx.ui.notify(diagnostics.join("\n"), "error");
}

export default function dynamicToolsExtension(pi: ExtensionAPI) {
	let config = loadDynamicToolsConfig();
	let activeDynamicTools = new Set<string>();
	let pendingContinuation: string | undefined;
	let shuttingDown = false;

	const reloadConfig = () => {
		config = loadDynamicToolsConfig();
		return validateDynamicToolDag(config);
	};

	const applyActiveTools = () => {
		const active = pi.getActiveTools();
		const managed = managedDynamicTools(config);
		let next = active.filter((toolName) => !managed.has(toolName) || activeDynamicTools.has(toolName));
		for (const root of config.roots) {
			if (!next.includes(root)) next.push(root);
		}
		for (const toolName of activeDynamicTools) {
			if (!next.includes(toolName)) next.push(toolName);
		}
		next = [...new Set(next)];
		if (!arraysEqual(active, next)) pi.setActiveTools(next);
	};

	const resetFrontier = () => {
		activeDynamicTools = new Set<string>();
		applyActiveTools();
	};

	const refreshPolicy = () => {
		reloadConfig();
		applyActiveTools();
	};

	pi.registerCommand("dynamic-tools", {
		description: "Configure dynamic tool activation rules",
		handler: async (_args, ctx) => {
			let keepOpen = true;
			while (keepOpen) {
				const diagnostics = reloadConfig();
				const tools = collectToolChoices(pi, config);
				const toolInfoByName = new Map(pi.getAllTools?.().map((tool) => [tool.name, tool]) ?? []);
				const action = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
					const ruleItems: SelectItem[] = config.rules.map((rule) => ({
						value: `rule:${rule.id}`,
						label: `${rule.id}: ${rule.from} -> ${rule.to.join(", ")}`,
						description: ruleDescription(rule),
					}));
					const items: SelectItem[] = [
						{ value: "add-rule", label: "Add activation rule", description: "Create a parent -> child edge" },
						{
							value: "add-root",
							label: "Add root tool",
							description: "Keep a tool active whenever policy applies",
						},
						{
							value: "remove-root",
							label: "Remove root tool",
							description: config.roots.join(", ") || "No roots",
						},
						{
							value: "reset",
							label: "Reset active frontier",
							description: "Clear currently activated dynamic tools",
						},
						{ value: "reload", label: "Reload config", description: DYNAMIC_TOOLS_CONFIG_PATH },
						...ruleItems,
						{ value: "close", label: "Close" },
					];
					const container = new Container();
					container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
					container.addChild(new Text(theme.fg("accent", theme.bold("Dynamic Tools")), 1, 0));
					container.addChild(new Text(theme.fg("dim", `Config: ${DYNAMIC_TOOLS_CONFIG_PATH}`), 1, 0));
					container.addChild(new Text(theme.fg("dim", `Roots: ${config.roots.join(", ") || "none"}`), 1, 0));
					container.addChild(
						new Text(
							theme.fg("dim", `Active dynamic tools: ${[...activeDynamicTools].sort().join(", ") || "none"}`),
							1,
							0,
						),
					);
					for (const diagnostic of diagnostics) {
						container.addChild(new Text(theme.fg("error", diagnostic), 1, 0));
					}
					container.addChild(new Text("", 0, 0));
					const selectList = new SelectList(items, Math.min(items.length, 18), {
						selectedPrefix: (text) => theme.fg("accent", text),
						selectedText: (text) => theme.fg("accent", text),
						description: (text) => theme.fg("muted", text),
						scrollInfo: (text) => theme.fg("dim", text),
						noMatch: (text) => theme.fg("warning", text),
					});
					selectList.onSelect = (item) => done(item.value);
					selectList.onCancel = () => done(null);
					container.addChild(selectList);
					container.addChild(
						new Text(
							theme.fg("dim", "j/k or arrows move | l/enter select | h/esc close | choose a rule to edit"),
							1,
							0,
						),
					);
					container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
					return {
						render: (width: number) => container.render(width),
						invalidate: () => container.invalidate(),
						handleInput: (data: string) => {
							handleLocalSelectInput(selectList, items, data);
							tui.requestRender();
						},
					};
				});

				if (!action || action === "close") {
					keepOpen = false;
					continue;
				}
				if (action === "reload") {
					const diagnostics = reloadConfig();
					applyActiveTools();
					ctx.ui.notify(diagnostics.length ? diagnostics.join("\n") : "Dynamic tools config reloaded", "info");
					continue;
				}
				if (action === "reset") {
					resetFrontier();
					ctx.ui.notify("Dynamic tool frontier reset", "info");
					continue;
				}
				if (action === "add-root") {
					const tool = await pickTool(ctx, "Root tool", tools);
					if (!tool) continue;
					config = { ...config, roots: [...new Set([...config.roots, tool])] };
					saveDynamicToolsConfig(config);
					applyActiveTools();
					continue;
				}
				if (action === "remove-root") {
					const tool = await selectItem(
						ctx,
						"Remove root tool",
						config.roots.map((root) => ({ value: root, label: root })),
						"No root tools configured",
					);
					if (!tool) continue;
					config = { ...config, roots: config.roots.filter((root) => root !== tool) };
					saveDynamicToolsConfig(config);
					applyActiveTools();
					continue;
				}
				if (action === "add-rule") {
					const rule = await promptForRule(ctx, tools, toolInfoByName);
					if (!rule) continue;
					config = { ...config, rules: [...config.rules.filter((existing) => existing.id !== rule.id), rule] };
					saveDynamicToolsConfig(config);
					applyActiveTools();
					reportDiagnostics(ctx, validateDynamicToolDag(config));
					continue;
				}
				if (action.startsWith("rule:")) {
					const ruleId = action.slice("rule:".length);
					const rule = config.rules.find((candidate) => candidate.id === ruleId);
					if (!rule) continue;
					const ruleAction = await selectItem(ctx, `${rule.id}: ${rule.from} -> ${rule.to.join(", ")}`, [
						{ value: "edit", label: "Edit" },
						{ value: rule.enabled ? "disable" : "enable", label: rule.enabled ? "Disable" : "Enable" },
						{ value: "delete", label: "Delete" },
						{ value: "back", label: "Back" },
					]);
					if (ruleAction === "edit") {
						const updated = await promptForRule(ctx, tools, toolInfoByName, rule);
						if (!updated) continue;
						config = {
							...config,
							rules: config.rules.map((candidate) => (candidate.id === rule.id ? updated : candidate)),
						};
					} else if (ruleAction === "enable" || ruleAction === "disable") {
						config = setRuleEnabled(config, rule.id, ruleAction === "enable");
					} else if (ruleAction === "delete") {
						if (!(await ctx.ui.confirm("Delete dynamic tool rule", `Delete ${rule.id}?`))) continue;
						config = { ...config, rules: config.rules.filter((candidate) => candidate.id !== rule.id) };
						activeDynamicTools = new Set([...activeDynamicTools].filter((tool) => !rule.to.includes(tool)));
					} else {
						continue;
					}
					saveDynamicToolsConfig(config);
					applyActiveTools();
					reportDiagnostics(ctx, validateDynamicToolDag(config));
				}
			}
		},
	});

	pi.on("session_start", () => {
		shuttingDown = false;
		activeDynamicTools = new Set<string>();
		refreshPolicy();
	});
	pi.on("session_tree", () => {
		activeDynamicTools = new Set<string>();
		refreshPolicy();
	});
	pi.on("model_select", refreshPolicy);
	pi.on("before_agent_start", refreshPolicy);

	pi.on("tool_result", (event: ToolResultEvent) => {
		reloadConfig();
		const evaluation = evaluateDynamicToolRules(
			config,
			{ toolName: event.toolName, input: event.input, result: event.details },
			activeDynamicTools,
		);
		if (evaluation.matches.length === 0) return;
		applyActiveTools();
		const freshRunMatch = evaluation.matches.find(
			(match) => match.rule.freshRun === true && match.newlyActivated.length > 0,
		);
		if (freshRunMatch?.continuation) {
			pendingContinuation = freshRunMatch.continuation;
		}
	});

	pi.on("agent_end", () => {
		if (!pendingContinuation || shuttingDown) return;
		const continuation = pendingContinuation;
		pendingContinuation = undefined;
		setTimeout(() => {
			if (shuttingDown) return;
			applyActiveTools();
			pi.sendUserMessage(continuation);
		}, 0);
	});

	pi.on("session_shutdown", () => {
		shuttingDown = true;
		pendingContinuation = undefined;
		activeDynamicTools = new Set<string>();
	});
}
