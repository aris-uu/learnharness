import { courseViewOfChat, getChat } from "@/src/server";

/** The course this session is a sitting of, or null (plan window, chat menu). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ course: courseViewOfChat(id), chatId: id });
}
