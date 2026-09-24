/** Pi uses flat local names; Responses preserves Codex's clock namespace on the wire. */
export function localFunctionName(name: string, namespace?: string): string {
	return namespace === "clock" && (name === "sleep" || name === "curr_time") ? `clock__${name}` : name;
}
export function wireFunctionName(name: string, namespace?: string): { name: string; namespace?: string } {
	if (name === "clock__sleep" || name === "clock__curr_time") return { name: name.slice(7), namespace: "clock" };
	return { name, ...(namespace === undefined ? {} : { namespace }) };
}
