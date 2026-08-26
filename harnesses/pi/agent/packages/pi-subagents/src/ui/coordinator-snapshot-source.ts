import type { SubagentCoordinator, TranscriptSource } from "../runtime/coordinator.ts";
import type { AgentHubSnapshot, AgentHubSnapshotSource } from "./agent-browser.ts";

/** Adapts coordinator state into immutable presentation snapshots. */
export class CoordinatorSnapshotSource implements AgentHubSnapshotSource {
	private generation = 0;
	private snapshotValue: AgentHubSnapshot;
	private readonly transcripts = new Map<string, TranscriptSource>();
	private readonly listeners = new Set<(snapshot: AgentHubSnapshot) => void>();
	private readonly unsubscribeCoordinator: () => void;

	constructor(private readonly coordinator: SubagentCoordinator) {
		this.snapshotValue = this.buildSnapshot();
		this.unsubscribeCoordinator = coordinator.subscribe((event) => {
			// TranscriptSource has its own narrow subscription. Avoid rebuilding every
			// agent row while a selected transcript streams.
			if (event.type === "transcript") return;
			this.generation += 1;
			this.snapshotValue = this.buildSnapshot();
			for (const listener of [...this.listeners]) listener(this.snapshotValue);
		});
	}

	getSnapshot(): AgentHubSnapshot {
		return this.snapshotValue;
	}

	subscribe(listener: (snapshot: AgentHubSnapshot) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		this.unsubscribeCoordinator();
		this.listeners.clear();
		this.transcripts.clear();
	}

	private buildSnapshot(): AgentHubSnapshot {
		const agents = this.coordinator.snapshot().map((agent) => {
			let transcript = this.transcripts.get(agent.id);
			if (!transcript) {
				transcript = this.coordinator.transcript(agent.id);
				if (!transcript) throw new Error(`Transcript unavailable for ${agent.id}`);
				this.transcripts.set(agent.id, transcript);
			}
			return Object.freeze({ ...agent, transcript });
		});
		return Object.freeze({ generation: this.generation, agents: Object.freeze(agents) });
	}
}
