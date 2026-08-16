export interface PtyProcess {
	readonly pid?: number;
	readonly name?: string;
	write(data: string): void | Promise<void>;
	resize(cols: number, rows: number): void | Promise<void>;
	kill(): void;
	onData(listener: (data: string) => void): void;
	onExit(listener: (event: { exitCode: number; sessionError?: string }) => void): void;
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
