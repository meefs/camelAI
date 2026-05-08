import { WorkerEntrypoint } from "cloudflare:workers";

interface LocalConnectionsEnv {
	CAMELAI_CONNECTIONS_URL?: string;
	MCP_SERVER_URL?: string;
}

export interface ConnectionSummary {
	id: string;
	type: string;
	name: string;
	displayName: string;
	category: string;
	authMethod: string;
	hasCredentials: boolean;
	capabilities: string[];
	nativeMcp: {
		serverName: string;
		transport: "streamable_http";
		directConnect: false;
	} | null;
}

export interface McpToolSummary {
	name: string;
	description?: string;
	inputSchema?: unknown;
	[key: string]: unknown;
}

function fallbackConnectionsUrl(env: LocalConnectionsEnv): string {
	const explicit = (env.CAMELAI_CONNECTIONS_URL ?? "").trim();
	if (explicit) return explicit.replace(/\/+$/, "");

	const mcpBase = (env.MCP_SERVER_URL ?? "").trim().replace(/\/+$/, "");
	if (mcpBase) return `${mcpBase.replace(/\/mcp$/, "")}/api/connections`;

	throw new Error("CAMELAI_CONNECTIONS_URL is not configured for local CONNECTIONS service");
}

async function request<T>(
	env: LocalConnectionsEnv,
	action: string,
	payload: Record<string, unknown> = {}
): Promise<T> {
	const response = await fetch(fallbackConnectionsUrl(env), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ action, ...payload }),
	});

	const body = await response.json().catch(() => null) as { error?: unknown } | T | null;
	if (!response.ok) {
		throw new Error(
			typeof body === "object" && body && typeof body.error === "string"
				? body.error
				: `Local connections request failed (${response.status})`
		);
	}
	return body as T;
}

/**
 * Local CONNECTIONS shim used by the starter template.
 * Deploy pipeline rewrites this binding to the platform's internal ConnectionsService.
 */
export class LocalConnectionsService extends WorkerEntrypoint<LocalConnectionsEnv> {
	async list(): Promise<ConnectionSummary[]> {
		return request<ConnectionSummary[]>(this.env, "list");
	}

	async get(connection: string): Promise<ConnectionSummary> {
		return request<ConnectionSummary>(this.env, "get", { connection });
	}

	async tools(connection: string): Promise<McpToolSummary[]> {
		return request<McpToolSummary[]>(this.env, "tools", { connection });
	}

	async call<T = unknown>(
		connection: string,
		tool: string,
		input: Record<string, unknown> = {}
	): Promise<T> {
		return request<T>(this.env, "call", { connection, tool, input });
	}
}
