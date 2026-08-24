export { SemanticEditor, semanticEditorTheme } from "./editor/presentation.ts";
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
