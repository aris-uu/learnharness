/**
 * GET /api/memory — the review badge's poll: how many memory items are due
 * now. Read only.
 */
import { memoryDueSplit } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	// due = everything; mature goes to review, learning to consolidation.
	return Response.json(memoryDueSplit());
}
