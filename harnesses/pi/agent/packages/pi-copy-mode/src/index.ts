export {
	COPY_MODE_ACTIONS,
	type CopyModeAction,
	type CopyModeKeybindings,
	loadCopyModeKeybindings,
	matchCopyModeAction,
} from "./config/keybindings.ts";
export {
	type CursorDocument,
	type CursorMotion,
	type CursorPoint,
	clampCursor,
	graphemeEnd,
	moveCursor,
	moveVirtualCursor,
	scrollTopForCursor,
	type VirtualCursorDocument,
} from "./core/cursor.ts";
