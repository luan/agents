import * as childProcess from "node:child_process";
import { getCapabilities, getCellDimensions, setCapabilities, setCellDimensions } from "@earendil-works/pi-tui";

type NativeImageProtocol = "kitty" | "iterm2";

let configured = false;
let tmuxClientTermCache: string | null | undefined;

function isTmuxSession(): boolean {
	return !!process.env.TMUX || /^(tmux|screen)/.test(process.env.TERM ?? "");
}

function normalizeTerminalName(term: string): string {
	const t = term.toLowerCase();
	if (t.includes("bootty")) return "bootty";
	if (t.includes("kitty")) return "kitty";
	if (t.includes("ghostty")) return "ghostty";
	if (t.includes("wezterm")) return "WezTerm";
	if (t.includes("iterm")) return "iTerm.app";
	if (t.includes("mintty")) return "mintty";
	return term;
}

export function imageCellDimensionsForTerminal(
	term: string,
	measured: { widthPx: number; heightPx: number },
	widthOverride = process.env.PI_IMAGE_CELL_WIDTH_PX,
	heightOverride = process.env.PI_IMAGE_CELL_HEIGHT_PX,
): { widthPx: number; heightPx: number } {
	const widthPx = Number(widthOverride);
	const heightPx = Number(heightOverride);
	if (widthPx > 0 && heightPx > 0) return { widthPx, heightPx };
	if (normalizeTerminalName(term) === "bootty") return { widthPx: 7, heightPx: 22 };
	return measured;
}

function readTmuxClientTerm(): string | null {
	if (!isTmuxSession()) return null;
	if (tmuxClientTermCache !== undefined) return tmuxClientTermCache;
	try {
		const term = childProcess
			.execFileSync("tmux", ["display-message", "-p", "#{client_termname}"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 200,
			})
			.trim();
		tmuxClientTermCache = term ? normalizeTerminalName(term) : null;
	} catch {
		tmuxClientTermCache = null;
	}
	return tmuxClientTermCache;
}

function readTmuxOption(args: string[]): string | null {
	try {
		const value = childProcess
			.execFileSync("tmux", args, {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 200,
			})
			.trim();
		return value || null;
	} catch {
		return null;
	}
}

function tmuxPassthroughEnabled(): boolean {
	const value = readTmuxOption(["show-options", "-qv", "-p", "allow-passthrough"])?.toLowerCase();
	return value === "on" || value === "all";
}

function tmuxClientSupportsKittyImages(): boolean {
	const term = readTmuxClientTerm();
	return term === "bootty" || term === "ghostty" || term === "kitty" || term === "WezTerm";
}

export function imageProtocolForTerminal(term: string): NativeImageProtocol | null {
	const normalized = normalizeTerminalName(term);
	if (normalized === "bootty" || normalized === "ghostty" || normalized === "kitty" || normalized === "WezTerm") {
		return "kitty";
	}
	if (normalized === "iTerm.app" || normalized === "mintty") return "iterm2";
	return null;
}

function detectImageProtocol(): NativeImageProtocol | null {
	const forced = (process.env.PI_IMAGE_PROTOCOL ?? process.env.PRETTY_IMAGE_PROTOCOL ?? "").toLowerCase();
	if (forced === "kitty" || forced === "iterm2") return forced;
	if (forced === "none") return null;

	if (process.env.LC_TERMINAL === "iTerm2") return "iterm2";
	if (process.env.GHOSTTY_RESOURCES_DIR || process.env.KITTY_WINDOW_ID || process.env.KITTY_PID) return "kitty";
	if (process.env.WEZTERM_EXECUTABLE || process.env.WEZTERM_CONFIG_DIR || process.env.WEZTERM_CONFIG_FILE) {
		return "kitty";
	}

	const termProgram = process.env.TERM_PROGRAM ?? "";
	const term =
		termProgram && termProgram !== "tmux" && termProgram !== "screen"
			? termProgram
			: (readTmuxClientTerm() ?? process.env.TERM ?? "");
	return imageProtocolForTerminal(term);
}

export function configureImageCapabilities(): void {
	if (configured) return;
	configured = true;

	const cellDimensions = imageCellDimensionsForTerminal(process.env.TERM ?? "", getCellDimensions());
	setCellDimensions(cellDimensions);

	const capabilities = getCapabilities();
	if (capabilities.images) return;
	if (isTmuxSession() && (!tmuxPassthroughEnabled() || !tmuxClientSupportsKittyImages())) return;

	const protocol = detectImageProtocol();
	if (!protocol) return;

	setCapabilities({
		...capabilities,
		images: protocol,
		trueColor: capabilities.trueColor || process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit",
	});
}
