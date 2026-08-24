import { tuiTheme } from "pi-libtui";

declare const theme: Parameters<typeof tuiTheme>[0];
const colors = tuiTheme(theme);

export const rendered = colors.bg("surface.raised", colors.fg("accent", "semantic"));
