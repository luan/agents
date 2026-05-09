import type { FileFinder } from "@ff-labs/fff-node";
import { loadFffNodeModule } from "./fff-runtime";

export interface FffClientOptions {
	frecencyDbPath?: string;
	historyDbPath?: string;
}

export class FffClient {
	private finder: FileFinder | null = null;
	private finderCwd: string | null = null;

	constructor(private options: FffClientOptions) {}

	get currentFinder(): FileFinder | null {
		return this.finder && !this.finder.isDestroyed ? this.finder : null;
	}

	async ensure(cwd: string): Promise<FileFinder> {
		if (this.finder && !this.finder.isDestroyed && this.finderCwd === cwd) return this.finder;
		this.destroy();

		this.finder = await this.create(cwd);
		this.finderCwd = cwd;
		return this.finder;
	}

	destroy(): void {
		if (this.finder && !this.finder.isDestroyed) {
			this.finder.destroy();
		}
		this.finder = null;
		this.finderCwd = null;
	}

	private async create(cwd: string): Promise<FileFinder> {
		const { FileFinder } = await loadFffNodeModule();
		const result = FileFinder.create({
			basePath: cwd,
			frecencyDbPath: this.options.frecencyDbPath,
			historyDbPath: this.options.historyDbPath,
			// Pi is a long-lived TUI process; keep FFF as an on-demand query engine
			// instead of leaving native watcher/content-index background threads alive.
			disableWatch: true,
			disableContentIndexing: true,
			disableMmapCache: true,
			aiMode: true,
		});

		if (!result.ok) throw new Error(`Failed to create FFF file finder: ${result.error}`);

		const finder = result.value;
		await finder.waitForScan(15000);
		return finder;
	}
}
