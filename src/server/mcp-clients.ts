/**
 * The custom MCP client pool (core/mcp.ts): one persistent client per
 * enabled server, process-global so every Next route module shares it.
 *
 * - A server connects on first use (the first turn of an agent it is ticked
 *   for, or a status check) and stays connected.
 * - A change to its transport or secrets reconnects it; disabling or
 *   removing it closes it (reconcile).
 * - A failed connect is recorded as the server's status and retried on the
 *   next use; it never blocks a turn beyond the connect timeout.
 * - Its tools become native AgentTools named mcp_<server>_<tool>. Calls run
 *   without approval: enabling a server trusts it.
 */

import { createHash } from "node:crypto";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema, type Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import packageJson from "../../package.json";
import { MCP_AGENTS, mcpToolName, type McpAgent, type McpServerSecrets, type McpServerSettings } from "../core/mcp.ts";

const CONNECT_TIMEOUT_MS = 30_000;
/** A tool call may run long (a build, a search); progress notifications extend it. */
const CALL_TIMEOUT_MS = 5 * 60_000;
const STDERR_TAIL_CHARS = 2_000;

export type McpServerStatus =
	| { state: "disabled" }
	| { state: "connected"; tools: { name: string; description?: string }[] }
	| { state: "error"; error: string };

/** The transport factory seam: tests connect an in-memory server. */
export type McpTransportFactory = (server: McpServerSettings, secrets: McpServerSecrets) => { transport: Transport; stderr?: () => string };

interface Connection {
	key: string;
	ready: Promise<{ client: Client; tools: McpTool[] }>;
	client?: Client;
	tools: McpTool[];
	stderr?: () => string;
	error?: string;
	closed: boolean;
}

const connectionKey = (server: McpServerSettings, secrets: McpServerSecrets) =>
	createHash("sha256").update(JSON.stringify({ transport: server.transport, secrets })).digest("hex");

export const defaultTransportFactory: McpTransportFactory = (server, secrets) => {
	if (server.transport.type === "http") {
		return {
			transport: new StreamableHTTPClientTransport(new URL(server.transport.url), {
				requestInit: { headers: { ...(secrets.headers ?? {}) } },
			}),
		};
	}
	// The minimal default environment plus the server's own secrets: the app's
	// API keys and other process env never reach a server's child process.
	const transport = new StdioClientTransport({
		command: server.transport.command,
		args: server.transport.args,
		...(server.transport.cwd ? { cwd: server.transport.cwd } : {}),
		env: { ...getDefaultEnvironment(), ...(secrets.env ?? {}) },
		stderr: "pipe",
	});
	let tail = "";
	transport.stderr?.on("data", (chunk: Buffer | string) => {
		tail = (tail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
	});
	return { transport, stderr: () => tail.trim() };
};

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
	]).finally(() => clearTimeout(timer));
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

type McpContent = { type: string; text?: string; data?: string; mimeType?: string; resource?: unknown; uri?: string; name?: string };

/** MCP result content → native content: text and images pass through; anything else as JSON text. */
export function toNativeContent(content: readonly McpContent[] | undefined, structured?: unknown): (TextContent | ImageContent)[] {
	const out: (TextContent | ImageContent)[] = [];
	for (const block of content ?? []) {
		if (block.type === "text" && typeof block.text === "string") out.push({ type: "text", text: block.text });
		else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
			out.push({ type: "image", data: block.data, mimeType: block.mimeType });
		} else out.push({ type: "text", text: JSON.stringify(block) });
	}
	if (out.length === 0 && structured !== undefined) out.push({ type: "text", text: JSON.stringify(structured) });
	if (out.length === 0) out.push({ type: "text", text: "(no content)" });
	return out;
}

export function createMcpPool(transportFor: McpTransportFactory = defaultTransportFactory) {
	const connections = new Map<string, Connection>();

	const close = (id: string) => {
		const conn = connections.get(id);
		if (!conn) return;
		connections.delete(id);
		conn.closed = true;
		void conn.ready.then(({ client }) => client.close()).catch(() => {});
	};

	const connect = (server: McpServerSettings, secrets: McpServerSecrets, key: string): Connection => {
		const conn: Connection = { key, tools: [], closed: false, ready: undefined as never };
		conn.ready = (async () => {
			let client: Client | undefined;
			let stderr: (() => string) | undefined;
			try {
				const made = transportFor(server, secrets);
				stderr = made.stderr;
				conn.stderr = stderr;
				const live = new Client({ name: "learnharness", version: packageJson.version });
				client = live;
				await withTimeout(live.connect(made.transport), CONNECT_TIMEOUT_MS, `connecting timed out after ${CONNECT_TIMEOUT_MS / 1000}s`);
				const listed = await withTimeout(live.listTools(), CONNECT_TIMEOUT_MS, "listing tools timed out");
				conn.client = live;
				conn.tools = listed.tools;
				live.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
					try { conn.tools = (await live.listTools()).tools; }
					catch (error) { console.error(`[mcp] ${server.name}: refreshing tools failed:`, error); }
				});
				// A closed connection (server exit, network loss) is dropped so the next use reconnects.
				live.onclose = () => { if (connections.get(server.id) === conn && !conn.closed) connections.delete(server.id); };
				return { client: live, tools: listed.tools };
			} catch (error) {
				const tail = stderr?.();
				conn.error = tail ? `${errorText(error)}\n${tail}` : errorText(error);
				void client?.close().catch(() => {});
				throw new Error(conn.error);
			}
		})();
		conn.ready.catch(() => {});
		connections.set(server.id, conn);
		return conn;
	};

	/** The live connection for a server, (re)connecting when needed. */
	const ensure = (server: McpServerSettings, secrets: McpServerSecrets): Connection => {
		const key = connectionKey(server, secrets);
		const existing = connections.get(server.id);
		if (existing && existing.key === key && !existing.error) return existing;
		if (existing) close(server.id);
		return connect(server, secrets, key);
	};

	const toolFor = (server: McpServerSettings, conn: Connection, tool: McpTool): AgentTool<any> => {
		const name = mcpToolName(server.name, tool.name);
		return {
			name,
			label: `${server.name}: ${tool.title ?? tool.name}`,
			description: tool.description ?? `${tool.name} (MCP server ${server.name})`,
			parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as AgentTool<any>["parameters"],
			execute: async (_toolCallId, input, signal): Promise<AgentToolResult<any>> => {
				// No details: the transcript card shows details when present, and
				// falls back to the native content (the tool's real output) otherwise.
				const client = conn.client;
				if (!client || conn.closed) {
					return { content: [{ type: "text", text: `MCP server "${server.name}" is no longer connected.` }], isError: true, details: undefined };
				}
				try {
					const result = await client.callTool(
						{ name: tool.name, arguments: (input ?? {}) as Record<string, unknown> },
						undefined,
						{ signal, timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true },
					);
					const content = toNativeContent(result.content as McpContent[] | undefined, result.structuredContent);
					return { content, ...(result.isError === true ? { isError: true } : {}), details: undefined };
				} catch (error) {
					return { content: [{ type: "text", text: `MCP tool "${tool.name}" on "${server.name}" failed: ${errorText(error)}` }], isError: true, details: undefined };
				}
			},
		};
	};

	/** Close connections whose server is gone, disabled, or reconfigured. */
	const reconcile = (servers: readonly McpServerSettings[], secrets: Record<string, McpServerSecrets>) => {
		const live = new Map(servers.filter((s) => s.enabled).map((s) => [s.id, s]));
		for (const [id, conn] of connections) {
			const server = live.get(id);
			if (!server || conn.key !== connectionKey(server, secrets[id] ?? {})) close(id);
		}
	};

	return {
		reconcile,

		/** Every enabled server's tools, grouped by the agents each is ticked for. */
		async toolsByAgent(servers: readonly McpServerSettings[], secrets: Record<string, McpServerSecrets>, reserved: ReadonlySet<string> = new Set()) {
			reconcile(servers, secrets);
			const byAgent = Object.fromEntries(MCP_AGENTS.map((agent) => [agent, [] as AgentTool<any>[]])) as Record<McpAgent, AgentTool<any>[]>;
			const wanted = servers.filter((s) => s.enabled && s.agents.length > 0);
			const settled = await Promise.all(wanted.map(async (server) => {
				const conn = ensure(server, secrets[server.id] ?? {});
				try { await conn.ready; return { server, conn }; }
				catch (error) { console.error(`[mcp] ${server.name}: ${errorText(error)}`); return null; }
			}));
			const taken = new Set(reserved);
			for (const entry of settled) {
				if (!entry) continue;
				const tools: AgentTool<any>[] = [];
				for (const tool of entry.conn.tools) {
					const native = toolFor(entry.server, entry.conn, tool);
					if (taken.has(native.name)) { console.warn(`[mcp] ${entry.server.name}: skipping "${tool.name}", its name ${native.name} is taken`); continue; }
					taken.add(native.name);
					tools.push(native);
				}
				for (const agent of entry.server.agents) byAgent[agent].push(...tools);
			}
			return byAgent;
		},

		/** The settings page's view of one server; connects it when enabled. */
		async status(server: McpServerSettings, secrets: McpServerSecrets): Promise<McpServerStatus> {
			if (!server.enabled) { close(server.id); return { state: "disabled" }; }
			const conn = ensure(server, secrets);
			try {
				const { tools } = await conn.ready;
				return { state: "connected", tools: (conn.tools.length ? conn.tools : tools).map((t) => ({ name: mcpToolName(server.name, t.name), ...(t.description ? { description: t.description } : {}) })) };
			} catch (error) {
				return { state: "error", error: errorText(error) };
			}
		},

		close,
		async closeAll() {
			for (const id of [...connections.keys()]) close(id);
		},
	};
}

export type McpPool = ReturnType<typeof createMcpPool>;

interface McpGlobal { __lhMcpPool?: McpPool }

/** The process-global pool every route module shares. */
export function mcpPool(): McpPool {
	const global = globalThis as typeof globalThis & McpGlobal;
	global.__lhMcpPool ??= createMcpPool();
	return global.__lhMcpPool;
}
