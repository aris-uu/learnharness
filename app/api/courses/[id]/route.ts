import { editDigest, readCourseView, removeFromCourse, renameCourse } from "@/src/server";

/** One course: its view (GET), title/digest edits (PATCH), and ungrouping a sitting (DELETE ?chatId=). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const view = readCourseView(id);
	return view ? Response.json(view) : Response.json({ error: "Not found" }, { status: 404 });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { title?: unknown; digest?: unknown } | null;
	if (!readCourseView(id)) return Response.json({ error: "Not found" }, { status: 404 });
	if (typeof body?.title === "string" && !renameCourse(id, body.title)) return Response.json({ error: "title must not be empty" }, { status: 400 });
	if (typeof body?.digest === "string") editDigest(id, body.digest);
	return Response.json(readCourseView(id));
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chatId = new URL(req.url).searchParams.get("chatId");
	if (!chatId) return Response.json({ error: "chatId required" }, { status: 400 });
	if (!readCourseView(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const course = removeFromCourse(id, chatId);
	return Response.json({ courseId: course?.id ?? null });
}
