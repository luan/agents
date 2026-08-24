import { type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { loadActionKeybindings } from "pi-libactions/sdk";

export const COPY_MODE_ACTIONS = [
	"copy-mode.up",
	"copy-mode.down",
	"copy-mode.left",
	"copy-mode.right",
	"copy-mode.lineStart",
	"copy-mode.lineEnd",
	"copy-mode.top",
	"copy-mode.bottom",
	"copy-mode.halfPageUp",
	"copy-mode.halfPageDown",
	"copy-mode.pageUp",
	"copy-mode.pageDown",
	"copy-mode.wordForward",
	"copy-mode.wordEnd",
	"copy-mode.wordBackward",
	"copy-mode.bigWordForward",
	"copy-mode.bigWordEnd",
	"copy-mode.bigWordBackward",
	"copy-mode.findForward",
	"copy-mode.findBackward",
	"copy-mode.tillForward",
	"copy-mode.tillBackward",
	"copy-mode.repeatFind",
	"copy-mode.reverseFind",
	"copy-mode.paragraphForward",
	"copy-mode.paragraphBackward",
	"copy-mode.firstNonblank",
	"copy-mode.firstNonblankDown",
	"copy-mode.toggleSelection",
	"copy-mode.lineSelection",
	"copy-mode.columnSelection",
	"copy-mode.swapEnds",
	"copy-mode.clearSelection",
	"copy-mode.copy",
	"copy-mode.annotate",
	"copy-mode.react",
	"copy-mode.cancel",
	"copy-mode.foldPrefix",
	"copy-mode.foldOpen",
	"copy-mode.foldClose",
	"copy-mode.foldOpenAll",
	"copy-mode.foldCloseAll",
] as const;

export type CopyModeAction = (typeof COPY_MODE_ACTIONS)[number];
type FoldCopyModeAction =
	| "copy-mode.foldPrefix"
	| "copy-mode.foldOpen"
	| "copy-mode.foldClose"
	| "copy-mode.foldOpenAll"
	| "copy-mode.foldCloseAll";
export type CopyModeKeybindings = Record<Exclude<CopyModeAction, FoldCopyModeAction>, readonly KeyId[]> &
	Partial<Record<FoldCopyModeAction, readonly KeyId[]>>;

function emptyBindings(): CopyModeKeybindings {
	return {
		"copy-mode.up": [],
		"copy-mode.down": [],
		"copy-mode.left": [],
		"copy-mode.right": [],
		"copy-mode.lineStart": [],
		"copy-mode.lineEnd": [],
		"copy-mode.top": [],
		"copy-mode.bottom": [],
		"copy-mode.halfPageUp": [],
		"copy-mode.halfPageDown": [],
		"copy-mode.pageUp": [],
		"copy-mode.pageDown": [],
		"copy-mode.wordForward": [],
		"copy-mode.wordEnd": [],
		"copy-mode.wordBackward": [],
		"copy-mode.bigWordForward": [],
		"copy-mode.bigWordEnd": [],
		"copy-mode.bigWordBackward": [],
		"copy-mode.findForward": [],
		"copy-mode.findBackward": [],
		"copy-mode.tillForward": [],
		"copy-mode.tillBackward": [],
		"copy-mode.repeatFind": [],
		"copy-mode.reverseFind": [],
		"copy-mode.paragraphForward": [],
		"copy-mode.paragraphBackward": [],
		"copy-mode.firstNonblank": [],
		"copy-mode.firstNonblankDown": [],
		"copy-mode.toggleSelection": [],
		"copy-mode.lineSelection": [],
		"copy-mode.columnSelection": [],
		"copy-mode.swapEnds": [],
		"copy-mode.clearSelection": [],
		"copy-mode.copy": [],
		"copy-mode.annotate": [],
		"copy-mode.react": [],
		"copy-mode.cancel": [],
		"copy-mode.foldPrefix": [],
		"copy-mode.foldOpen": [],
		"copy-mode.foldClose": [],
		"copy-mode.foldOpenAll": [],
		"copy-mode.foldCloseAll": [],
	};
}

export function loadCopyModeKeybindings(path?: string): CopyModeKeybindings {
	const result = emptyBindings();
	const bindings = path === undefined ? loadActionKeybindings() : loadActionKeybindings(path);
	for (const action of COPY_MODE_ACTIONS) {
		result[action] = bindings[action] ?? [];
	}
	return result;
}

export function matchCopyModeAction(data: string, bindings: CopyModeKeybindings): CopyModeAction | undefined {
	return COPY_MODE_ACTIONS.find((action) => bindings[action]?.some((key) => matchesKey(data, key)));
}
