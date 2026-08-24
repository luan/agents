import type { TuiForegroundColor } from "pi-libtui";
import type { ModelRoleColor } from "../core/catalog.ts";

const ROLE_COLORS: Readonly<Record<ModelRoleColor, TuiForegroundColor>> = {
	gray: { hue: "gray", shade: 3 },
	red: { hue: "red", shade: 4 },
	green: { hue: "green", shade: 3 },
	yellow: { hue: "yellow", shade: 3 },
	blue: { hue: "blue", shade: 4 },
	magenta: { hue: "magenta", shade: 4 },
	cyan: { hue: "cyan", shade: 3 },
};

export function roleColor(color: ModelRoleColor): TuiForegroundColor {
	return ROLE_COLORS[color];
}
