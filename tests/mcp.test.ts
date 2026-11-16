import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
	mcpToolName,
	parseMcpServerFields,
	parseMcpSecrets,
	readMcpSecretsRecord,
	sanitizeMcpServers,
	type McpServerSettings,
} from "../src/core/mcp.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { createMcpPool, toNativeContent, type McpTransportFactory } from "../src/server/mcp-clients.ts";
import { toolFallbackPart } from "../components/plugin-renderers.tsx";

const server = (over: Partial<McpServerSettings> = {}): McpServerSettings => ({
	id: "0123456789abcdef", name: "calc", enabled: true,
	transport: { type: "stdio", command: "node", args: ["server.js"] }, agents: ["teacher"], ...over,
});

/** An in-memory MCP server with an `add` tool and a failing `boom` tool. */
function memoryFactory(counter = { connects: 0, closes: 0 }): McpTransportFactory {
	return () => {
		counter.connects++;
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		const mcp = new Server({ name: "test", version: "1.0.0" }, { capabilities: { tools: {} } });
		mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
			tools: [
				{ name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
				{ name: "boom", inputSchema: { type: "object", properties: {} } },
			],
		}));
		mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
			if (request.params.name === "boom") return { content: [{ type: "text", text: "exploded" }], isError: true };
			const { a, b } = request.params.arguments as { a: number; b: number };
			return { content: [{ type: "text", text: String(a + b) }] };
		});
		mcp.onclose = () => { counter.closes++; };
		void mcp.connect(serverSide);
		return { transport: clientSide };
	};
}

describe("MCP settings", () => {
	it("parses stdio and http servers strictly", () => {
		const stdio = parseMcpServerFields({ name: "calc", enabled: true, transport: { type: "stdio", command: " npx ", args: ["-y", "pkg"] }, agents: ["teacher", "prober"] });
		assert.ok(stdio.ok);
		assert.deepEqual(stdio.value.transport, { type: "stdio", command: "npx", args: ["-y", "pkg"] });
		assert.deepEqual(stdio.value.agents, ["prober", "teacher"], "agents normalize to the canonical order");
		assert.ok(parseMcpServerFields({ name: "web", enabled: false, transport: { type: "http", url: "https://example.com/mcp" }, agents: [] }).ok);
		assert.equal(parseMcpServerFields({ name: "bad name", enabled: true, transport: { type: "http", url: "https://x" }, agents: [] }).ok, false);
		assert.equal(parseMcpServerFields({ name: "x", enabled: true, transport: { type: "http", url: "ftp://x" }, agents: [] }).ok, false);
		assert.equal(parseMcpServerFields({ name: "x", enabled: true, transport: { type: "stdio", command: "" }, agents: [] }).ok, false);
		assert.equal(parseMcpServerFields({ name: "x", enabled: true, transport: { type: "http", url: "https://x" }, agents: ["researcher"] }).ok, false);
	});
	it("reads the stored list leniently and survives the settings sanitizer", () => {
		const good = { ...server(), transport: { type: "stdio", command: "node", args: [] } };
		const list = sanitizeMcpServers([good, { ...good, id: "fedcba9876543210", name: "CALC" }, { id: "bad" }]);
		assert.equal(list!.length, 1, "repeated names (case-insensitive) and invalid entries drop");
		const settings = sanitizeUserSettings({ version: 1, agent: { mcpServers: [good] } });
		assert.equal(settings?.agent?.mcpServers?.[0]?.name, "calc");
	});
	it("parses secrets and reads the private record leniently", () => {
		assert.deepEqual(parseMcpSecrets({ env: { API_KEY: "s" } }), { ok: true, value: { env: { API_KEY: "s" } } });
		assert.equal(parseMcpSecrets({ env: { "BAD NAME": "s" } }).ok, false);
		assert.equal(parseMcpSecrets({ headers: { Authorization: 1 } }).ok, false);
		const record = readMcpSecretsRecord(JSON.stringify({ "0123456789abcdef": { headers: { Authorization: "Bearer t" } }, nope: {} }));
		assert.deepEqual(Object.keys(record), ["0123456789abcdef"]);
		assert.deepEqual(readMcpSecretsRecord("not json"), {});
	});
	it("names tools provider-safely within 64 characters", () => {
		assert.equal(mcpToolName("calc", "add.numbers"), "mcp_calc_add_numbers");
		assert.equal(mcpToolName("calc", "x".repeat(100)).length, 64);
	});
});

describe("MCP client pool", () => {
	it("exposes a server's tools to the agents it is ticked for, and calls them", async () => {
		const pool = createMcpPool(memoryFactory());
		const byAgent = await pool.toolsByAgent([server({ agents: ["prober", "teacher"] })], {});
		assert.deepEqual(byAgent.teacher.map((t) => t.name), ["mcp_calc_add", "mcp_calc_boom"]);
		assert.deepEqual(byAgent.prober.map((t) => t.name), ["mcp_calc_add", "mcp_calc_boom"]);
		assert.deepEqual(byAgent.practice, []);
		const add = byAgent.teacher[0]!;
		const result = await add.execute("call", { a: 2, b: 3 });
		assert.deepEqual(result.content, [{ type: "text", text: "5" }]);
		assert.notEqual(result.isError, true);
		assert.equal(result.details, undefined, "no details, so the transcript card shows the content");
		assert.equal(toolFallbackPart({ type: "tool-mcp_calc_add", state: "output-available", toolCallId: "call", result: { content: result.content, details: result.details, isError: false } } as never).output, "5");
		const boom = await byAgent.teacher[1]!.execute("call2", {});
		assert.equal(boom.isError, true);
		await pool.closeAll();
	});
	it("leaves out disabled servers and names that are taken", async () => {
		const pool = createMcpPool(memoryFactory());
		const off = await pool.toolsByAgent([server({ enabled: false })], {});
		assert.deepEqual(off.teacher, []);
		const reserved = await pool.toolsByAgent([server()], {}, new Set(["mcp_calc_add"]));
		assert.deepEqual(reserved.teacher.map((t) => t.name), ["mcp_calc_boom"]);
		await pool.closeAll();
	});
	it("reuses a connection, and reconnects when the transport or secrets change", async () => {
		const counter = { connects: 0, closes: 0 };
		const pool = createMcpPool(memoryFactory(counter));
		await pool.toolsByAgent([server()], {});
		await pool.toolsByAgent([server({ name: "renamed", agents: ["practice"] })], {});
		assert.equal(counter.connects, 1, "name and agents changes keep the connection");
		await pool.toolsByAgent([server()], { "0123456789abcdef": { env: { KEY: "v" } } });
		assert.equal(counter.connects, 2);
		pool.reconcile([], {});
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.ok(counter.closes >= 1, "a removed server's connection closes");
		await pool.closeAll();
	});
	it("reports a failing server as an error status and leaves it out of the turn", async () => {
		const pool = createMcpPool(() => { throw new Error("spawn npx ENOENT"); });
		const status = await pool.status(server(), {});
		assert.equal(status.state, "error");
		assert.match((status as { error: string }).error, /ENOENT/);
		const byAgent = await pool.toolsByAgent([server()], {});
		assert.deepEqual(byAgent.teacher, []);
		assert.deepEqual(await pool.status(server({ enabled: false }), {}), { state: "disabled" });
	});
	it("maps result content to native content", () => {
		assert.deepEqual(toNativeContent([{ type: "image", data: "AAAA", mimeType: "image/png" }]), [{ type: "image", data: "AAAA", mimeType: "image/png" }]);
		assert.deepEqual(toNativeContent([], { answer: 1 }), [{ type: "text", text: "{\"answer\":1}" }]);
		assert.deepEqual(toNativeContent(undefined), [{ type: "text", text: "(no content)" }]);
		assert.equal(toNativeContent([{ type: "resource_link", uri: "file://x", name: "x" }])[0]!.type, "text");
	});
});
