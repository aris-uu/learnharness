/**
 * /api/mcp — custom MCP servers (src/server/mcp.ts).
 *   GET              the configured servers, with secret NAMES only
 *   POST             create: { server, secrets? }
 *   PUT ?id=<id>     replace one server: { server, secrets? } (empty secret value = keep)
 *   DELETE ?id=<id>  remove one server and its secrets
 * Secret values never leave the server through this API.
 */
import { createMcpServer, deleteMcpServer, listMcpServers, updateMcpServer } from "@/src/server";

export const dynamic = "force-dynamic";

const idOf = (request: Request) => new URL(request.url).searchParams.get("id") ?? "";
const fail = (outcome: { status: number; error: string }) => Response.json({ error: outcome.error }, { status: outcome.status });

export async function GET() {
	return Response.json({ servers: listMcpServers() });
}

export async function POST(request: Request) {
	const body = await request.json().catch(() => null);
	const outcome = createMcpServer(body);
	return outcome.ok ? Response.json({ server: outcome.value }, { status: 201 }) : fail(outcome);
}

export async function PUT(request: Request) {
	const body = await request.json().catch(() => null);
	const outcome = updateMcpServer(idOf(request), body);
	return outcome.ok ? Response.json({ server: outcome.value }) : fail(outcome);
}

export async function DELETE(request: Request) {
	const outcome = deleteMcpServer(idOf(request));
	return outcome.ok ? new Response(null, { status: 204 }) : fail(outcome);
}
