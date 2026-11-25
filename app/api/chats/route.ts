import { chainsForSelection, formatChainLine, isTimeboxOption } from "@/src/core";
import { newGraphContextMessage, type GraphContextPick } from "@/src/core";
import { compactionInFlight, continueCourse, createChat, isTurnRunning, listChats, nextReviewTitle, readSettingsRecord, stores, titleFromPrompt } from "@/src/server";
import type { ChatListItem } from "@/src/core";

/** The session picker's list: record-derived summaries (phase, pending
 *  question) + live liveness — a running turn marks the session busy
 *  (contracts.ts ChatListItem; the store can't see liveness, the route is
 *  the merge point). Owner, minimal-color round: background jobs NO LONGER
 *  count — the sidebar's Background agents section is their channel now
 *  (a running spinner per row would double-signal them), so busy means
 *  exactly "a teach turn is in flight". */
export async function GET() {
	const chats: ChatListItem[] = listChats().map((c) => ({
		...c,
		busy: isTurnRunning(c.id),
		compacting: compactionInFlight(c.id),
	}));
	return Response.json({ chats });
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { title?: unknown; kind?: unknown; graphContext?: unknown; profile?: unknown; timeboxMin?: unknown; consolidate?: unknown; continuesFrom?: unknown; courseId?: unknown };
	const title = typeof body.title === "string" ? body.title : "";
	// Practice sessions (owner, 2026-10-04): kind "practice" marks the
	// record — the practice agent + its tools from turn 1, no extraction.
	// Review sessions (retention mode, 2026-11-18): titled by date, as many
	// a day as the learner starts; the opening prompt is what they typed.
	const kind = body.kind === "practice" ? ("practice" as const) : body.kind === "review" ? ("review" as const) : undefined;
	const consolidate = kind === "review" && body.consolidate === true;
	const reviewName = nextReviewTitle(Date.now(), consolidate ? "Consolidate" : "Review");
	const chat = createChat(kind === "review" ? reviewName : titleFromPrompt(title || "Untitled session"), kind);
	// PER-SESSION MODELS (owner, 2026-09-28): a session owns its model +
	// thinking level from birth — stamped verbatim from the STRONG slot,
	// the new-session default. From here the strong slot never reaches
	// this session again: in-session picks write the session's own record
	// (PUT /api/chats/:id/settings). No strong slot configured (fresh BYOK
	// boot) → no stamp; the turn gate's 503 models_not_configured envelope
	// refuses honestly until the setup flow fills the slot.
	const strong = readSettingsRecord()?.models?.strong;
	if (strong?.model) {
		stores.chatStore.saveSettings(chat.id, {
			model: { provider: strong.model.provider, id: strong.model.id },
			thinkingLevel: strong.thinkingLevel,
		});
	}
	if (kind === undefined && body.profile === "math") {
		stores.chatStore.saveSettings(chat.id, { ...stores.chatStore.getChat(chat.id)?.settings, profile: "math" });
	}
	// Time-boxed sittings and consolidation (2026-11-20): stamped at birth.
	if (kind !== "practice" && isTimeboxOption(body.timeboxMin)) {
		stores.chatStore.saveSettings(chat.id, { ...stores.chatStore.getChat(chat.id)?.settings, timeboxMin: body.timeboxMin });
	}
	// Courses (docs/course-plans-plan.md §5): "Start next sitting" from a
	// course page names the course; it continues from its latest sitting.
	if (typeof body.continuesFrom !== "string" && typeof body.courseId === "string") {
		const course = stores.courseStore.get(body.courseId);
		const last = course?.sittings.at(-1)?.chatId;
		if (last) body.continuesFrom = last;
	}
	if (typeof body.continuesFrom === "string" && stores.chatStore.getChat(body.continuesFrom)) {
		const current = stores.chatStore.getChat(chat.id)?.settings;
		stores.chatStore.saveSettings(chat.id, { ...current, timebox: { ...current?.timebox, continuesFrom: body.continuesFrom } });
	}
	if (consolidate) {
		stores.chatStore.saveSettings(chat.id, { ...stores.chatStore.getChat(chat.id)?.settings, consolidate: true });
	}
	// The session's map context (owner, 2026-10-04): the picked
	// propositions ride the CREATION — message[0] is a graph-context
	// marker (a separate custom message BEFORE the learner's first user
	// message), carrying the picks plus the reasoning chains among them.
	// The picks carry their own name/statement (what the learner saw at
	// pick time); the chains derive from the CURRENT graph snapshot.
	const rawPicks = (body.graphContext as { propositions?: unknown } | undefined)?.propositions;
	const picks: GraphContextPick[] = Array.isArray(rawPicks)
		? rawPicks
				.filter(
						(p): p is GraphContextPick =>
							typeof p === "object" &&
							p !== null &&
							typeof (p as GraphContextPick).id === "string" &&
							typeof (p as GraphContextPick).name === "string" &&
							typeof (p as GraphContextPick).statement === "string",
					)
					.slice(0, 64)
			: [];
	if (picks.length > 0) {
		const byId = new Map(stores.graphStore.readNodes().map((n) => [n.id, n]));
		const pickedNodes = picks.map((p) => byId.get(p.id)).filter((n) => n !== undefined);
		const chainLines = chainsForSelection(pickedNodes, stores.graphStore.readChains()).map((c) =>
			formatChainLine(c, Object.fromEntries(byId)),
		);
		stores.chatStore.saveMessages(chat.id, [newGraphContextMessage(picks, chainLines)]);
	}
	// The new chat joins the earlier sitting's course (created on demand):
	// the course map, sources and digest reach it through the seed.
	let courseId: string | undefined;
	if (kind === undefined && typeof body.continuesFrom === "string" && stores.chatStore.getChat(body.continuesFrom)) {
		try { courseId = continueCourse(chat.id, body.continuesFrom)?.id; }
		catch (error) { console.error(`[course] continue failed for ${chat.id}:`, error); }
	}
	return Response.json({ id: chat.id, title: chat.title, ...(courseId ? { courseId } : {}) });
}
