import { renderCellCall, renderCellResult } from "./render.ts";

export const cellToolPresentation = {
	renderShell: "self" as const,
	emptyRenderIsFinal: true,
	rendersOwnFailure: true,
	renderCall: renderCellCall,
	renderResult: renderCellResult,
};
