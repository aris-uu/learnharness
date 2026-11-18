/**
 * GET /api/memory — the review badge's poll: how many memory items are due
 * now, and today's review session if one exists. Read only.
 */
import { memoryDueCount, todaysReviewChat } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const today = todaysReviewChat();
	return Response.json({ due: memoryDueCount(), ...(today ? { todaysReview: today } : {}) });
}
