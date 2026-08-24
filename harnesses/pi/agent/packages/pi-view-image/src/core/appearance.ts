import type { PillContent, TuiForegroundColor, TuiIconName } from "pi-libtui";

/** Shared visual identity for every view-image entry point. */
export const VIEW_IMAGE_ICON = "view-image" satisfies TuiIconName;
export const VIEW_IMAGE_ICON_TONE = { hue: "magenta", shade: 2 } as const satisfies TuiForegroundColor;

export const VIEW_IMAGE_PILL_IDENTITY = {
	icon: VIEW_IMAGE_ICON,
	iconTone: VIEW_IMAGE_ICON_TONE,
} as const satisfies Pick<PillContent, "icon" | "iconTone">;
