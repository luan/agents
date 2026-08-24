declare const piTheme: {
	fg(token: string, text: string): string;
};

export const rendered = piTheme.fg("accent", "direct");
