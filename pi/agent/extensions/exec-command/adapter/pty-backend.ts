import * as pty from "node-pty";

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
		spawn: (file, args, options) => pty.spawn(file, args, options),
	};
}
