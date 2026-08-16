/**
 * The matcher the prune and status actions use.
 *
 * There is no default glob. Prune deletes, so an absent glob must be a caller error, not a match on
 * everything. `globMatcher("")` throws for that reason.
 */
export function globMatcher(glob: string): (value: string) => boolean {
	if (glob.length === 0) throw new Error("Notebook glob is required; prune never matches everything by default");
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	const expression = new RegExp(`^${escaped}$`, "i");
	return (value) => expression.test(value);
}
