import { adoptChat, applyGroup, CourseGroupError, listCourses, proposeGroup } from "@/src/server";
import type { NodeMatchRow } from "@/src/core";

/**
 * Courses (docs/course-plans-plan.md). GET lists them for the sidebar;
 * POST adopts one session (§9.1), proposes a grouping table, or applies a
 * table the learner confirmed (§9.2). Nothing is written by "propose".
 */
export async function GET() {
	return Response.json({ courses: listCourses() });
}

const strings = (value: unknown): string[] | null =>
	Array.isArray(value) && value.every((v) => typeof v === "string") ? value.slice(0, 50) : null;

function rowsOf(value: unknown): NodeMatchRow[] | null {
	if (!Array.isArray(value)) return null;
	const rows: NodeMatchRow[] = [];
	for (const raw of value.slice(0, 500)) {
		const row = raw as Partial<NodeMatchRow> | null;
		if (!row || typeof row.courseNodeId !== "string" || typeof row.title !== "string" || !row.from || typeof row.from !== "object") return null;
		if (row.action !== "merge" && row.action !== "separate" && row.action !== "drop") return null;
		const from = Object.fromEntries(Object.entries(row.from).filter(([, v]) => typeof v === "string")) as Record<string, string>;
		rows.push({ courseNodeId: row.courseNodeId.trim(), title: row.title.trim() || row.courseNodeId, from, action: row.action, reason: typeof row.reason === "string" ? row.reason : "" });
	}
	return rows;
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as { action?: unknown; chatId?: unknown; chatIds?: unknown; courseId?: unknown; rows?: unknown; title?: unknown } | null;
	const courseId = typeof body?.courseId === "string" ? body.courseId : null;
	try {
		if (body?.action === "adopt") {
			if (typeof body.chatId !== "string") return Response.json({ error: "chatId required" }, { status: 400 });
			const course = adoptChat(body.chatId);
			return course ? Response.json({ courseId: course.id }) : Response.json({ error: "Not found" }, { status: 404 });
		}
		const chatIds = strings(body?.chatIds);
		if (!chatIds) return Response.json({ error: "chatIds must be a list of session ids" }, { status: 400 });
		if (body?.action === "propose") return Response.json(proposeGroup(courseId, chatIds));
		if (body?.action === "group") {
			const rows = rowsOf(body.rows);
			if (!rows) return Response.json({ error: "rows must be a confirmed matching table" }, { status: 400 });
			const course = applyGroup({ courseId, chatIds, rows, ...(typeof body.title === "string" ? { title: body.title } : {}) });
			return Response.json({ courseId: course.id });
		}
		return Response.json({ error: "action must be adopt, propose or group" }, { status: 400 });
	} catch (error) {
		if (error instanceof CourseGroupError) return Response.json({ error: error.message }, { status: 400 });
		throw error;
	}
}
