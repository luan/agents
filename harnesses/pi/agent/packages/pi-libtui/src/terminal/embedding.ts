const TOP_LEVEL_ZONE_MARKER = /\x1b\]133;[ABC](?:\x07|\x1b\\)/gu;

/** Remove terminal-wide transcript zones before embedding rendered lines inside another surface. */
export function stripTopLevelZoneMarkers(lines: readonly string[]): string[] {
	return lines.map((line) => line.replace(TOP_LEVEL_ZONE_MARKER, ""));
}
