/** The only mutable context surface exposed by token-burden: active tools for future turns. */
export interface ToolControlRuntime {
	getAllTools(): readonly { name: string }[];
	getActiveTools(): readonly string[];
	setActiveTools(names: string[]): void;
	waitForIdle?: () => Promise<void>;
}

export type ToolControlResult =
	| { applied: true; tool: string; active: readonly string[]; message: string }
	| {
			applied: false;
			tool: string;
			reason: "unknown-tool" | "busy" | "error";
			message: string;
			error?: unknown;
	  };

export type ToolControlStatus =
	| { kind: "idle" }
	| { kind: "pending"; tool: string; enabled: boolean }
	| { kind: "applied"; tool: string; enabled: boolean; message: string }
	| { kind: "error"; tool: string; message: string };

/**
 * Narrow, non-persistent active-tool controller. It deliberately does not know
 * about skills, context files, extensions, or private tool policy state.
 */
export class ToolControlService {
	private statusValue: ToolControlStatus = { kind: "idle" };

	constructor(private readonly runtime: ToolControlRuntime) {}

	status(): ToolControlStatus {
		return this.statusValue;
	}

	isKnownTool(name: string): boolean {
		return this.runtime.getAllTools().some((tool) => tool.name === name);
	}

	async toggle(name: string, enabled: boolean): Promise<ToolControlResult> {
		if (!this.isKnownTool(name)) {
			const result: ToolControlResult = {
				applied: false,
				tool: name,
				reason: "unknown-tool",
				message: `Unknown tool “${name}”; no changes applied.`,
			};
			this.statusValue = { kind: "error", tool: name, message: result.message };
			return result;
		}
		if (!this.runtime.waitForIdle) {
			const result: ToolControlResult = {
				applied: false,
				tool: name,
				reason: "busy",
				message: "Tool changes are unavailable while the agent is busy.",
			};
			this.statusValue = { kind: "error", tool: name, message: result.message };
			return result;
		}
		this.statusValue = { kind: "pending", tool: name, enabled };
		try {
			await this.runtime.waitForIdle();
			// Read immediately before applying so unrelated changes made while waiting survive.
			const active = new Set(this.runtime.getActiveTools());
			if (enabled) active.add(name);
			else active.delete(name);
			this.runtime.setActiveTools([...active]);
			const applied = [...this.runtime.getActiveTools()];
			const message = `${name} ${applied.includes(name) ? "enabled" : "disabled"} for future turns. No history or settings changed.`;
			this.statusValue = { kind: "applied", tool: name, enabled: applied.includes(name), message };
			return { applied: true, tool: name, active: applied, message };
		} catch (error) {
			const message = `Could not change ${name}; no confirmed change was applied.`;
			this.statusValue = { kind: "error", tool: name, message };
			return { applied: false, tool: name, reason: "error", message, error };
		}
	}
}
