export interface AgentModelRole {
	name: string;
	color: string;
}

/** Child-specific model-role choice; installed resources are rediscovered for each child session. */
export interface AgentConfig {
	role?: string;
}
