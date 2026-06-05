import type { ViewNode } from "./types";

export interface SurfaceContribution {
	id: string;
	priority?: number;
	view: ViewNode | (() => ViewNode);
}

export interface SurfaceDiagnostic {
	code: "exclusive-surface-conflict";
	surface: string;
	message: string;
}

export interface SurfaceRegistry {
	contribute(surface: string, contribution: SurfaceContribution): void;
	replace(surface: string, contribution: SurfaceContribution): void;
	resolveShared(surface: string): SurfaceContribution[];
	resolveExclusive(surface: string): SurfaceContribution | undefined;
	diagnostics(): SurfaceDiagnostic[];
}

export function createSurfaceRegistry(): SurfaceRegistry {
	return new SurfaceRegistryImpl();
}

class SurfaceRegistryImpl implements SurfaceRegistry {
	private shared = new Map<string, SurfaceContribution[]>();
	private exclusive = new Map<string, SurfaceContribution[]>();

	contribute(surface: string, contribution: SurfaceContribution): void {
		const entries = this.shared.get(surface) ?? [];
		entries.push(withSequence(contribution));
		this.shared.set(surface, entries);
	}

	replace(surface: string, contribution: SurfaceContribution): void {
		const entries = this.exclusive.get(surface) ?? [];
		entries.push(withSequence(contribution));
		this.exclusive.set(surface, entries);
	}

	resolveShared(surface: string): SurfaceContribution[] {
		return [...(this.shared.get(surface) ?? [])].sort(byPriorityThenSequence);
	}

	resolveExclusive(surface: string): SurfaceContribution | undefined {
		return [...(this.exclusive.get(surface) ?? [])].sort(byPriorityThenSequence)[0];
	}

	diagnostics(): SurfaceDiagnostic[] {
		const diagnostics: SurfaceDiagnostic[] = [];
		for (const [surface, entries] of this.exclusive) {
			const sorted = [...entries].sort(byPriorityThenSequence);
			const winner = sorted[0];
			if (!winner) continue;
			const winnerPriority = winner.priority ?? 0;
			const tied = sorted.filter((entry) => (entry.priority ?? 0) === winnerPriority);
			if (tied.length <= 1) continue;
			diagnostics.push({
				code: "exclusive-surface-conflict",
				surface,
				message: `Exclusive surface "${surface}" has competing replacements at priority ${winnerPriority}: ${tied
					.map((entry) => entry.id)
					.join(", ")}`,
			});
		}
		return diagnostics;
	}
}

let nextSequence = 0;

type SequencedContribution = SurfaceContribution & { sequence: number };

function withSequence(contribution: SurfaceContribution): SequencedContribution {
	return { ...contribution, sequence: nextSequence++ };
}

function byPriorityThenSequence(left: SurfaceContribution, right: SurfaceContribution): number {
	const priority = (right.priority ?? 0) - (left.priority ?? 0);
	if (priority !== 0) return priority;
	return sequenceOf(left) - sequenceOf(right);
}

function sequenceOf(contribution: SurfaceContribution): number {
	return (contribution as Partial<SequencedContribution>).sequence ?? 0;
}
