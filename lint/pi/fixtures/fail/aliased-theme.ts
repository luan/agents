declare const piTheme: {
	fg(token: string, text: string): string;
};

const paint = piTheme;
export const rendered = paint.fg("accent", "aliased");
