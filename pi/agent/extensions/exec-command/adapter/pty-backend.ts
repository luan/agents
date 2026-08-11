export interface PtyProcess {
	readonly pid?: number;
	readonly name?: string;
	readonly attachCommand?: string;
	readonly attachment?: { command: string; args: string[] };
	write(data: string): void | Promise<void>;
	resize(cols: number, rows: number): void | Promise<void>;
	kill(): void;
	onData(listener: (data: string) => void): void;
	onExit(listener: (event: { exitCode: number }) => void): void;
}

export interface PtySpawnOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	name: string;
	sessionName?: string;
	cols: number;
	rows: number;
}

export interface PtyBackend {
	spawn(file: string, args: string[], options: PtySpawnOptions): PtyProcess | Promise<PtyProcess>;
}

export function createNodePtyBackend(): PtyBackend {
	return {
		// Imported on first spawn, never at module load: node-pty installs a SIGCHLD reaper
		// that swallows exit notifications for every other child in the process, which hangs
		// anything awaiting a child's exit. Bun never reaches this backend — it runs PTYs in
		// the node-pty host process — so a Bun agent must not pay that cost for an unused import.
		spawn: async (file, args, options) => (await import("node-pty")).spawn(file, args, options),
	};
}
