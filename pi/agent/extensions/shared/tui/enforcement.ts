const RAW_TUI_SURFACE_METHODS = [
	"custom",
	"setWidget",
	"setFooter",
	"setStatus",
	"setWorkingIndicator",
	"setEditorComponent",
] as const;

interface SourceFile {
	path: string;
	source: string;
}

interface RawTuiSurfaceViolation {
	path: string;
	method: (typeof RAW_TUI_SURFACE_METHODS)[number];
	message: string;
}

export function enforceNoRawTuiSurfaceCalls(files: SourceFile[]): RawTuiSurfaceViolation[] {
	const violations: RawTuiSurfaceViolation[] = [];
	for (const file of files) {
		if (isAllowedAdapter(file.path)) continue;
		for (const method of RAW_TUI_SURFACE_METHODS) {
			if (!new RegExp(`\\bctx\\.ui\\.${method}\\s*\\(`).test(file.source)) continue;
			violations.push({
				path: file.path,
				method,
				message: `Raw ctx.ui.${method} surface call must go through shared/tui`,
			});
		}
	}
	return violations;
}

function isAllowedAdapter(path: string): boolean {
	return /(^|\/)shared\/tui(\/|$)/.test(path);
}
