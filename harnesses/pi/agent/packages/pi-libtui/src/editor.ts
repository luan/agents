export { SemanticEditor, semanticEditorTheme } from "./editor/presentation.ts";
export {
	composeEditorStatus,
	editorCompositionCadenceMs,
	editorCompositionContentWidth,
	editorStatusSeparator,
	type EditorBottomTreatment,
	type EditorCompositionPreview,
	type EditorCompositionRenderOptions,
	type EditorCompositionStatus,
	type EditorCompositionStyle,
	type EditorPromptMarkerMotion,
	type EditorRailStyle,
	type EditorStatusBandStyle,
	type EditorStatusSeparator,
	type EditorSurfaceStyle,
	type EditorTopTreatment,
	renderEditorComposition,
	renderEditorCompositionPreview,
	renderEditorCompositionStatus,
} from "./editor/chrome.ts";
export {
	type EditorFactory,
	type EditorLayer,
	type EditorUi,
	installEditorLayer,
} from "./editor/composition.ts";
export {
	type EditorMinimumRowsLease,
	installEditorMinimumRows,
} from "./editor/layout.ts";
export {
	dispatchEditorPaste,
	dispatchEditorRender,
	EDITOR_PROTOCOL,
	EDITOR_REGISTRY_KEY,
	type EditorPasteHandler,
	type EditorRegistry,
	type EditorRenderDecorator,
	ensureEditorRegistry,
} from "./editor/protocol.ts";
