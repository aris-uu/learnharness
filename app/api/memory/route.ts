/**
 * GET /api/memory — the review badge's poll: how many memory items are due
 * now. Read only.
 */
import { memoryDueCount } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ due: memoryDueCount() });
}
