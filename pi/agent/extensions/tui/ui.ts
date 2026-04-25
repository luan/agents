import {
  CustomEditor,
  type KeybindingsManager,
  type Theme,
  UserMessageComponent,
} from "@mariozechner/pi-coding-agent";
import {
  type Component,
  Container,
  type EditorTheme,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const originalUserMessageRender = UserMessageComponent.prototype.render;

type AutocompleteEditorInternals = {
  autocompleteList?: Pick<Component, "render">;
  isShowingAutocomplete?: () => boolean;
};

let currentUiTheme: Theme | undefined;

const ESCAPE_PATTERN = "\\x1B";
const RESET_ANSI = new RegExp(`${ESCAPE_PATTERN}\\[0m`, "g");
const RESET = "\x1b[0m";

function fillLine(content: string, width: number): string {
  const truncated = truncateToWidth(content, width, "");
  const spaces = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
  return `${truncated}${spaces}`;
}

function fillBackgroundLine(
  uiTheme: Theme,
  content: string,
  width: number,
): string {
  const filled = fillLine(content, width);
  const sample = uiTheme.bg("customMessageBg", " ");
  const spaceIndex = sample.indexOf(" ");
  if (spaceIndex < 0) return uiTheme.bg("customMessageBg", filled);

  const backgroundStart = sample.slice(0, spaceIndex);
  const backgroundEnd = sample.slice(spaceIndex + 1);
  return `${backgroundStart}${filled.replace(RESET_ANSI, `${RESET}${backgroundStart}`)}${backgroundEnd}`;
}

export function patchUserMessageComponent(uiTheme: Theme): void {
  currentUiTheme = uiTheme;

  const prototype = UserMessageComponent.prototype as {
    render(width: number): string[];
  };
  prototype.render = function (
    this: UserMessageComponent,
    width: number,
  ): string[] {
    if (!currentUiTheme) {
      return originalUserMessageRender.call(this, width);
    }

    const railWidth = 2;
    const innerWidth = Math.max(1, width - railWidth);
    const baseLines = Container.prototype.render.call(
      this,
      innerWidth,
    ) as string[];
    if (baseLines.length === 0) return baseLines;

    const hasLeadingSpacer =
      baseLines.length > 1 && visibleWidth(baseLines[0] ?? "") === 0;
    const leadingLines = hasLeadingSpacer ? [baseLines[0] ?? ""] : [];
    const contentLines = hasLeadingSpacer ? baseLines.slice(1) : baseLines;
    const rail = `${currentUiTheme.fg("border", "┃")}${RESET}${currentUiTheme.bg("customMessageBg", " ")}`;
    const styledLines = contentLines.map(
      (line) =>
        `${rail}${fillBackgroundLine(currentUiTheme as Theme, line, innerWidth)}`,
    );

    if (styledLines.length === 0) {
      return leadingLines;
    }

    styledLines[0] = OSC133_ZONE_START + styledLines[0];
    styledLines[styledLines.length - 1] =
      styledLines[styledLines.length - 1] +
      OSC133_ZONE_END +
      OSC133_ZONE_FINAL;
    return [...leadingLines, ...styledLines];
  };
}

export class PolishedEditor extends CustomEditor {
  private readonly getModelMeta: () => string;
  private readonly getThinkingLevel: () => string | undefined;
  private readonly uiTheme: Theme;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    uiTheme: Theme,
    getModelMeta: () => string,
    getThinkingLevel: () => string | undefined,
  ) {
    super(tui, theme, keybindings, { paddingX: 0 });
    this.borderColor = (text: string) => uiTheme.fg("border", text);
    this.uiTheme = uiTheme;
    this.getModelMeta = getModelMeta;
    this.getThinkingLevel = getThinkingLevel;
  }

  /**
   * Hook for extensions to transform each editor content line before the
   * rail and background decoration is applied. Default is identity. Other
   * extensions (e.g. skill-dollar) reassign this on the live instance to
   * inject inline highlighting that needs to render cleanly underneath
   * customMessageBg without fighting post-wrap ANSI sequences.
   */
  transformEditorLine(line: string): string {
    return line;
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const rendered = super.render(innerWidth);
    const editorInternals = this as unknown as AutocompleteEditorInternals;
    const isShowingAutocomplete =
      typeof editorInternals.isShowingAutocomplete === "function"
        ? Boolean(editorInternals.isShowingAutocomplete())
        : false;

    if (rendered.length < 2) {
      return super.render(width);
    }

    const { autocompleteList } = editorInternals;
    const autocompleteCount =
      isShowingAutocomplete && typeof autocompleteList?.render === "function"
        ? autocompleteList.render(innerWidth).length
        : 0;
    const editorFrame =
      autocompleteCount > 0 && autocompleteCount < rendered.length
        ? rendered.slice(0, -autocompleteCount)
        : rendered;
    const autocompleteLines =
      autocompleteCount > 0 && autocompleteCount < rendered.length
        ? rendered.slice(-autocompleteCount)
        : [];

    if (editorFrame.length < 2) {
      return rendered;
    }

    const editorLines = editorFrame
      .slice(1, -1)
      .map((line) => this.transformEditorLine(line));
    const metaParts = [this.getModelMeta()];
    const thinkingLevel = this.getThinkingLevel();
    if (thinkingLevel && thinkingLevel !== "off") {
      metaParts.push(this.uiTheme.fg("muted", thinkingLevel));
    }
    const meta = metaParts
      .filter(Boolean)
      .join(this.uiTheme.fg("border", "  "));

    const rail = `${this.uiTheme.fg("accent", "┃")}${RESET}${this.uiTheme.bg("customMessageBg", " ")}`;
    const lines = ["", ...editorLines, "", meta];

    return [
      ...lines.map(
        (line) => `${rail}${fillBackgroundLine(this.uiTheme, line, innerWidth)}`,
      ),
      ...autocompleteLines,
    ];
  }
}
