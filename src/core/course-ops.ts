/**
 * Course operations over the storage ports (docs/course-plans-plan.md).
 * Shared by the teacher's tools (src/agent/tools) and the course routes
 * (src/server/courses.ts): both reach the stores only through ports, so
 * this lives in core. No fs or network here.
 */
import type { ChatRecord, PlanTree } from "./contracts.ts";
import type { ChatStore } from "./ports.ts";
import type { MathStore } from "./math-concepts.ts";
import { storeSnapshot } from "./memory/items.ts";
import type { FsrsWeights } from "./memory/fsrs.ts";
import { danglingQuestionOf, type LhMessage } from "./native-messages.ts";
import {
	attachmentPaths, courseNodeViews, courseSeed, emptyCourse, isCourseId, reconstructedHandoff, upsertSitting, withMap,
	type CourseNodeFacts, type CourseNodeView, type CourseRecord, type CourseSitting, type CourseSource, type CourseStore,
} from "./course.ts";

export interface CoursePorts {
	chatStore: ChatStore;
	courseStore: CourseStore;
	/** The global math record: course node facts are its concepts' facts. */
	mathStore?: MathStore;
	weights?: () => FsrsWeights | undefined;
	now?: () => number;
}

const iso = (ports: CoursePorts) => new Date((ports.now ?? Date.now)()).toISOString();

/** The course a chat is a sitting of: its own settings link, else any course listing it. */
export function courseOfChat(ports: Pick<CoursePorts, "chatStore" | "courseStore">, chatId: string): CourseRecord | null {
	const linked = ports.chatStore.getChat(chatId)?.settings?.courseId;
	if (linked) {
		const course = ports.courseStore.get(linked);
		if (course?.sittings.some((s) => s.chatId === chatId)) return course;
	}
	return ports.courseStore.list().find((course) => course.sittings.some((s) => s.chatId === chatId)) ?? null;
}

function textOf(message: LhMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => (part as { type?: string; text?: string }).type === "text" ? (part as { text?: string }).text ?? "" : "").join("\n");
	return "";
}

/** The chat's first learner message as a course source. */
export function sourceFromChat(chat: ChatRecord): CourseSource | null {
	const first = chat.messages.find((m) => m.role === "user" && textOf(m).trim());
	if (!first) return null;
	const text = textOf(first);
	return { chatId: chat.id, messageId: first.id, text, attachments: attachmentPaths(text) };
}

export function sittingFromChat(chat: ChatRecord): CourseSitting {
	const timebox = chat.settings?.timebox;
	return {
		chatId: chat.id,
		startedAt: chat.createdAt,
		...(timebox?.closedAt ? { closedAt: timebox.closedAt } : {}),
		...(chat.settings?.timeboxMin ? { budgetMin: chat.settings.timeboxMin + (timebox?.extendedMin ?? 0) } : {}),
		kind: chat.kind ?? "teach",
		goals: timebox?.goals ?? [],
		...(timebox?.handoff ? { handoff: timebox.handoff, handoffSource: "close" as const } : {}),
	};
}

function linkChat(ports: CoursePorts, chatId: string, courseId: string): void {
	const chat = ports.chatStore.getChat(chatId);
	if (chat) ports.chatStore.saveSettings(chatId, { ...chat.settings, courseId });
}

function unlinkChat(ports: CoursePorts, chatId: string): void {
	const chat = ports.chatStore.getChat(chatId);
	if (!chat?.settings?.courseId) return;
	const { courseId: _gone, ...rest } = chat.settings;
	ports.chatStore.saveSettings(chatId, rest);
}

/**
 * The facts per course node: the node IS a global concept, so its facts are
 * the concept's over every session. `excludeChatId` leaves out one sitting
 * (the running one), so the seed in its system prompt stays stable while it
 * records evidence.
 */
export function courseFacts(ports: CoursePorts, course: CourseRecord, options: { excludeChatId?: string } = {}): Map<string, CourseNodeFacts> {
	const facts = new Map<string, CourseNodeFacts>();
	if (!ports.mathStore) return facts;
	const ids = new Set(course.map.nodes.map((n) => n.id));
	const store = ports.mathStore;
	const view: MathStore = options.excludeChatId
		? { ...store, attempts: () => store.attempts().filter((a) => a.chatId !== options.excludeChatId) }
		: store;
	const now = (ports.now ?? Date.now)();
	const attempts = view.attempts().filter((a) => ids.has(a.conceptId) && !a.implicit);
	for (const item of storeSnapshot(view, now, ports.weights?.())) {
		if (!ids.has(item.id) || item.evidenceCount === 0) continue;
		const own = attempts.filter((a) => a.conceptId === item.id);
		facts.set(item.id, {
			solid: item.mastery === "solid",
			attempted: own.some((a) => a.outcome !== "learner_override"),
			stale: item.stale,
			habits: own.flatMap((a) => a.habits ?? []),
		});
	}
	return facts;
}

export function courseViews(ports: CoursePorts, course: CourseRecord, options: { excludeChatId?: string } = {}): CourseNodeView[] {
	return courseNodeViews(course, courseFacts(ports, course, options));
}

/** The seed for a sitting's system prompt, or null when the chat is in no course. */
export function seedForChat(ports: CoursePorts, chatId: string): { seed: string; continuation: boolean } | null {
	const course = courseOfChat(ports, chatId);
	if (!course) return null;
	const titles = new Map(ports.chatStore.listChats().map((c) => [c.id, c.title]));
	const views = courseViews(ports, course, { excludeChatId: chatId });
	const index = course.sittings.findIndex((s) => s.chatId === chatId);
	const continuation = course.sittings.filter((s, i) => s.chatId !== chatId && (index < 0 || i < index)).length > 0;
	return { seed: courseSeed({ course, chatId, views, sittingTitle: (id) => titles.get(id) ?? id }), continuation };
}

/**
 * The chat's course, created when it has none (§2: every time-boxed teach
 * session implicitly starts a course of one; §9.1: adopting an old one).
 * A chat that was not closed gets a reconstructed hand-off when asked.
 */
export function ensureCourseForChat(ports: CoursePorts, chatId: string, options: { reconstruct?: boolean; title?: string } = {}): CourseRecord | null {
	const existing = courseOfChat(ports, chatId);
	if (existing) {
		if (ports.chatStore.getChat(chatId)?.settings?.courseId !== existing.id) linkChat(ports, chatId, existing.id);
		return existing;
	}
	const chat = ports.chatStore.getChat(chatId);
	if (!chat) return null;
	const now = iso(ports);
	let course = emptyCourse({ title: options.title ?? chat.title, nowIso: now, ...(chat.tree ? { map: chat.tree } : {}) });
	const source = sourceFromChat(chat);
	if (source) course = { ...course, sources: [source] };
	course = upsertSitting(course, sittingFromChat(chat), now);
	if (options.reconstruct && !chat.settings?.timebox?.closedAt) course = withReconstructedHandoff(ports, course, chat);
	ports.courseStore.save(course);
	linkChat(ports, chatId, course.id);
	return course;
}

function withReconstructedHandoff(ports: CoursePorts, course: CourseRecord, chat: ChatRecord): CourseRecord {
	const views = courseViews(ports, course).filter((v) => chat.tree?.nodes.some((n) => n.id === v.id) ?? false);
	const lastTeacher = [...chat.messages].reverse().find((m) => m.role === "assistant" && textOf(m).trim());
	const pendingInput = danglingQuestionOf(chat.messages)?.input as { question?: unknown } | undefined;
	const pending = typeof pendingInput?.question === "string" ? pendingInput.question : undefined;
	const lastNode = [...chat.messages].reverse().flatMap((m) => {
		const content = (m as { content?: unknown }).content;
		return Array.isArray(content) ? (content as Array<{ type?: string; arguments?: { nodeId?: unknown } }>).filter((c) => c.type === "toolCall" && typeof c.arguments?.nodeId === "string").map((c) => c.arguments!.nodeId as string) : [];
	})[0];
	const handoff = reconstructedHandoff({
		title: chat.title,
		views,
		...(lastNode ? { lastNodeTitle: chat.tree?.nodes.find((n) => n.id === lastNode)?.title ?? lastNode } : {}),
		...(lastTeacher ? { lastTeacherText: textOf(lastTeacher) } : {}),
		...(pending ? { pendingQuestion: pending } : {}),
	});
	return { ...course, sittings: course.sittings.map((s) => s.chatId === chat.id ? { ...s, handoff, handoffSource: "reconstructed" as const } : s) };
}

/**
 * A new chat continues `fromChatId`'s course: the course is ensured, the new
 * chat becomes its next sitting, and the course map is copied into the new
 * chat's tree so goals and checks can name course nodes from the start.
 */
export function startCourseSitting(ports: CoursePorts, newChatId: string, fromChatId: string): CourseRecord | null {
	const course = ensureCourseForChat(ports, fromChatId);
	const chat = ports.chatStore.getChat(newChatId);
	if (!course || !chat) return null;
	const next = upsertSitting(course, sittingFromChat(chat), iso(ports));
	ports.courseStore.save(next);
	linkChat(ports, newChatId, next.id);
	if (next.map.nodes.length && !chat.tree) ports.chatStore.saveTree(newChatId, { ...next.map, version: 1 });
	return next;
}

/** Refresh the sitting entry from its chat (goals, close, hand-off). */
export function syncSitting(ports: CoursePorts, chatId: string): CourseRecord | null {
	const course = courseOfChat(ports, chatId);
	const chat = ports.chatStore.getChat(chatId);
	if (!course || !chat) return null;
	const previous = course.sittings.find((s) => s.chatId === chatId);
	const fresh = sittingFromChat(chat);
	// A reconstructed hand-off survives until a real close replaces it.
	const sitting = !fresh.handoff && previous?.handoff ? { ...fresh, handoff: previous.handoff, ...(previous.handoffSource ? { handoffSource: previous.handoffSource } : {}) } : fresh;
	const next = upsertSitting(course, sitting, iso(ports));
	ports.courseStore.save(next);
	return next;
}

/** The node ids that have evidence anywhere in the course. */
export function evidencedCourseNodes(ports: CoursePorts, course: CourseRecord): Set<string> {
	return new Set([...courseFacts(ports, course).keys()]);
}

/** Write a sitting's new map into its course (§4 plan_init). */
export function saveCourseMap(ports: CoursePorts, course: CourseRecord, tree: PlanTree, chatId: string): CourseRecord {
	const next = withMap(course, tree, chatId, iso(ports));
	ports.courseStore.save(next);
	return next;
}

export function saveDigest(ports: CoursePorts, course: CourseRecord, digest: string): CourseRecord {
	const next = { ...course, digest, updatedAt: iso(ports) };
	ports.courseStore.save(next);
	return next;
}

// ─── Grouping (§9.2) ─────────────────────────────────────────────────────────

/** Remove a chat from its course: its sitting and source go; nothing else is touched (its concepts stay global). */
export function ungroupChat(ports: CoursePorts, courseId: string, chatId: string): CourseRecord | null {
	const course = ports.courseStore.get(courseId);
	if (!course) return null;
	const next: CourseRecord = {
		...course,
		sittings: course.sittings.filter((s) => s.chatId !== chatId),
		sources: course.sources.filter((s) => s.chatId !== chatId),
		updatedAt: iso(ports),
	};
	unlinkChat(ports, chatId);
	if (next.sittings.length === 0) { ports.courseStore.delete(courseId); return null; }
	ports.courseStore.save(next);
	return next;
}

export { isCourseId };
