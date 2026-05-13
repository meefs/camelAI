type ConnectionMethodCatalogEntry = {
	alias: string;
	connection: {
		id: string;
		type: string;
		name: string;
		displayName: string;
	};
	methods: Array<{
		name: string;
		tool: string;
		description?: string;
		inputSchema?: unknown;
		outputSchema?: unknown;
	}>;
	error?: {
		message: string;
		code?: unknown;
		data?: unknown;
	};
};

type ConnectionsBinding = {
	list(): Promise<unknown[]>;
	get(connection: string): Promise<unknown>;
	tools(connection: string): Promise<unknown[]>;
	methods(): Promise<ConnectionMethodCatalogEntry[]>;
	__invoke<T = unknown>(request: {
		connection: string;
		method?: string;
		input?: Record<string, unknown>;
	}): Promise<T>;
};

type ConnectionsEnv = {
	CONNECTIONS: ConnectionsBinding;
};

type ConnectionMethod = <T = unknown>(input?: Record<string, unknown>) => Promise<T>;
type ConnectionProxy = Record<string, ConnectionMethod>;
type ConnectionsProxy = Record<string, ConnectionProxy> & {
	/**
	 * Lists every connection plus callable method names and JSON schemas.
	 */
	$methods(): Promise<ConnectionMethodCatalogEntry[]>;
	$list(): Promise<unknown[]>;
	$get(connection: string): Promise<unknown>;
	$tools(connection: string): Promise<unknown[]>;
};

export function createConnections(env: ConnectionsEnv): ConnectionsProxy {
	const binding = env.CONNECTIONS;
	return new Proxy({} as ConnectionsProxy, {
		get(_target, connectionName) {
			if (connectionName === "then") return undefined;
			if (connectionName === "$methods") return () => binding.methods();
			if (connectionName === "$list") return () => binding.list();
			if (connectionName === "$get") return (connection: string) => binding.get(connection);
			if (connectionName === "$tools") return (connection: string) => binding.tools(connection);
			if (typeof connectionName !== "string") return undefined;

			return new Proxy({} as ConnectionProxy, {
				get(_connectionTarget, methodName) {
					if (methodName === "then") return undefined;
					if (typeof methodName !== "string") return undefined;
					return (input: Record<string, unknown> = {}) =>
						binding.__invoke({
							connection: connectionName,
							method: methodName,
							input,
						});
				},
			});
		},
	});
}
