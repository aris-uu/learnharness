/**
 * GET /api/mcp/status?id=<id> — one server's live status: connects an
 * enabled server and reports its tools, or the connection error.
 */
import { mcpServerStatus } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const outcome = await mcpServerStatus(new URL(request.url).searchParams.get("id") ?? "");
	return outcome.ok ? Response.json({ status: outcome.value }) : Response.json({ error: outcome.error }, { status: outcome.status });
}
