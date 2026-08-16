import { getImageDimensions } from "@earendil-works/pi-tui";

export function readImageDimensions(
	base64Data: string,
	mimeType: string,
): { widthPx: number; heightPx: number } | null {
	return getImageDimensions(base64Data, mimeType);
}
