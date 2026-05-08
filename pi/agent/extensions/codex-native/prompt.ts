export function buildCodexSystemPrompt(basePrompt: string): string {
	const toolsIndex = basePrompt.indexOf("\nAvailable tools:");
	const contextIndex = basePrompt.indexOf("\n# Project Context");
	let modifiedPrompt = basePrompt;
	if (toolsIndex !== -1 && contextIndex !== -1 && toolsIndex < contextIndex) {
		modifiedPrompt = `${basePrompt.slice(0, toolsIndex)}${basePrompt.slice(contextIndex)}`;
	}
	return modifiedPrompt;
}
