import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { KittyVirtualImage, resetKittyVirtualImageUploadCache } from "./kitty-virtual-image";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

describe("KittyVirtualImage", () => {
	beforeEach(() => {
		resetCapabilitiesCache();
		resetKittyVirtualImageUploadCache();
	});
	afterEach(() => {
		resetCapabilitiesCache();
		resetKittyVirtualImageUploadCache();
	});

	it("preserves aspect ratio when height limits the image", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const image = new KittyVirtualImage(
			PNG_BASE64,
			"image/png",
			{ fallbackColor: (text) => text },
			{
				maxWidthCells: 10,
				maxHeightCells: 3,
			},
		);

		const lines = image.render(80);

		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("\x1b_Ga=T");
		expect(lines[0]).toContain("f=100");
		expect(lines[0]).toContain("U=1");
		expect(lines[0]).toContain("c=6");
		expect(lines[0]).toContain("r=3");
		expect(lines[0].split("\u{10EEEE}")).toHaveLength(7);
		expect(lines.join("\n")).toContain("\u{10EEEE}");
		expect(lines.slice(1).every((line) => line.includes("\u{10EEEE}"))).toBe(true);
	});

	it("preserves aspect ratio when width limits a wide image", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const image = new KittyVirtualImage(
			PNG_BASE64,
			"image/png",
			{ fallbackColor: (text) => text },
			{ maxWidthCells: 80, maxHeightCells: 30 },
			{ widthPx: 1826, heightPx: 218 },
		);

		const lines = image.render(100);

		expect(lines).toHaveLength(5);
		expect(lines[0]).toContain("c=80");
		expect(lines[0]).toContain("r=5");
	});

	it("renders deterministic upload lines for differential TUI redraws", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const first = new KittyVirtualImage(
			PNG_BASE64,
			"image/png",
			{ fallbackColor: (text) => text },
			{
				maxWidthCells: 10,
				maxHeightCells: 3,
			},
		);
		const second = new KittyVirtualImage(
			PNG_BASE64,
			"image/png",
			{ fallbackColor: (text) => text },
			{
				maxWidthCells: 10,
				maxHeightCells: 3,
			},
		);

		const firstLine = first.render(80)[0];
		const secondLine = second.render(80)[0];

		expect(firstLine).toContain("\x1b_Ga=T");
		expect(secondLine).toContain("\x1b_Ga=T");
		expect(secondLine).toBe(firstLine);
	});

	it("uses kitty file references when a preview path is available", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const image = new KittyVirtualImage(
			PNG_BASE64,
			"image/png",
			{ fallbackColor: (text) => text },
			{
				maxWidthCells: 10,
				maxHeightCells: 3,
				sourcePath: "/tmp/pi-preview.png",
			},
		);

		const firstLine = image.render(80)[0];

		expect(firstLine).toContain("\x1b_Ga=T");
		expect(firstLine).toContain("t=f");
		expect(firstLine).toContain(Buffer.from("/tmp/pi-preview.png", "utf8").toString("base64"));
		expect(firstLine).not.toContain(PNG_BASE64);
	});

	it("keeps non-kitty rendering delegated to pi-tui Image", () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		const image = new KittyVirtualImage(
			PNG_BASE64,
			"image/png",
			{ fallbackColor: (text) => text },
			{
				maxWidthCells: 10,
				maxHeightCells: 3,
			},
		);

		expect(image.render(80).join("\n")).toContain("\x1b]1337;File=");
	});
});
