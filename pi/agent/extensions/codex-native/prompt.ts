const CODEX_GUIDELINES = [
  "Prefer a single `apply_patch` call that updates all related files together when one coherent patch will do.",
  "When multiple tool calls are independent, emit them together so they can execute in parallel instead of serializing them.",
  "Native Codex `image_generation` outputs are saved under `.pi/openai-codex-images/` and mirrored to `.pi/openai-codex-images/latest.png`.",
];
function insertBeforeTrailingContext(prompt: string, section: string): string {
  const currentDateIndex = prompt.lastIndexOf("\nCurrent date:");
  if (currentDateIndex !== -1) {
    return `${prompt.slice(0, currentDateIndex)}\n\n${section}${prompt.slice(currentDateIndex)}`;
  }
  return `${prompt}\n\n${section}`;
}

function injectShell(prompt: string, shell?: string): string {
  if (!shell) return prompt;
  if (/\nCurrent shell:/.test(prompt)) {
    return prompt.replace(/(^Current shell:) .*$/m, `$1 ${shell}`);
  }
  return insertBeforeTrailingContext(prompt, `Current shell: ${shell}`);
}

function injectGuidelines(prompt: string): string {
  const existing = new Set(
    prompt
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2)),
  );
  const additions = CODEX_GUIDELINES.filter((line) => !existing.has(line)).map(
    (line) => `- ${line}`,
  );
  if (additions.length === 0) return prompt;
  const match = prompt.match(
    /(^Guidelines:\n)([\s\S]*?)(\n\n(?:Pi documentation:|# Project Context|Current date:))/m,
  );
  if (!match || match.index === undefined) {
    return insertBeforeTrailingContext(
      prompt,
      `Codex mode guidelines:\n${additions.join("\n")}`,
    );
  }
  const replacement = `${match[1]}${match[2].trimEnd()}\n${additions.join("\n")}${match[3]}`;
  return `${prompt.slice(0, match.index)}${replacement}${prompt.slice(match.index + match[0].length)}`;
}

export function buildCodexSystemPrompt(basePrompt: string): string {
  return injectShell(injectGuidelines(basePrompt), process.env.SHELL);
}
