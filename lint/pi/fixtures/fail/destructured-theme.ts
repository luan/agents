declare const piTheme: {
	fg(token: string, text: string): string;
};

const { fg } = piTheme;
export const rendered = fg("accent", "destructured");
