export const REPORT_TABS = ["Overview", "Prompt", "Tools", "Usage", "Skills"] as const;
export type ReportTab = (typeof REPORT_TABS)[number];
export const nextTab = (tab: ReportTab, delta: number): ReportTab =>
	REPORT_TABS[(REPORT_TABS.indexOf(tab) + delta + REPORT_TABS.length) % REPORT_TABS.length] ?? "Overview";
