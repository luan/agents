export interface AgentModelRole {
	name: string;
	color: string;
}

/** The only child-specific runtime choice. All other environment state is inherited. */
export interface AgentConfig {
	role?: string;
}
