/**
 * Courses, server side (docs/course-plans-plan.md): the ports bound to the
 * wired stores, and the operations the course routes call. The logic lives
 * in core/course-ops.ts and core/course.ts; this file only binds stores and
 * shapes route payloads.
 */
import type { ChatRecord } from "../core/contracts.ts";
import {
	courseOfChat, courseViews, ensureCourseForChat, startCourseSitting, syncSitting, ungroupChat, saveDigest, sittingFromChat, sourceFromChat,
	type CoursePorts,
} from "../core/course-ops.ts";
import {
	courseItemKeys, courseProgress, emptyCourse, mapFromMatches, matchTableProblems, proposeNodeMatches, reconstructedHandoff, upsertSitting,
	type CourseNodeView, type CourseRecord, type NodeMatchRow,
} from "../core/course.ts";
import { stores } from "./stores.ts";

export function coursePorts(): CoursePorts {
	return {
		chatStore: stores.chatStore,
		courseStore: stores.courseStore,
		evidenceStore: stores.evidenceStore,
		reviews: () => stores.reviewStore.list(),
		weights: () => stores.fsrsWeightsStore.read(),
	};
}

export interface CourseSittingView {
	chatId: string;
	title: string;
	startedAt: string;
	closedAt?: string;
	budgetMin?: number;
	kind?: string;
	goals: CourseRecord["sittings"][number]["goals"];
	handoff?: string;
	handoffSource?: "close" | "reconstructed";
}

export interface CourseView {
	course: Pick<CourseRecord, "id" | "title" | "createdAt" | "updatedAt" | "digest" | "sources" | "map">;
	nodes: CourseNodeView[];
	progress: { done: number; total: number };
	sittings: CourseSittingView[];
}

export function readCourseView(courseId: string): CourseView | null {
	const course = stores.courseStore.get(courseId);
	if (!course) return null;
	const titles = new Map(stores.chatStore.listChats().map((c) => [c.id, c.title]));
	const nodes = courseViews(coursePorts(), course);
	return {
		course: { id: course.id, title: course.title, createdAt: course.createdAt, updatedAt: course.updatedAt, ...(course.digest ? { digest: course.digest } : {}), sources: course.sources, map: course.map },
		nodes,
		progress: courseProgress(nodes),
		sittings: course.sittings.map((s) => ({ ...s, title: titles.get(s.chatId) ?? s.chatId })),
	};
}

export function listCourses(): Array<{ id: string; title: string; updatedAt: string; sittings: string[]; progress: { done: number; total: number } }> {
	const ports = coursePorts();
	return stores.courseStore.list().map((course) => ({
		id: course.id,
		title: course.title,
		updatedAt: course.updatedAt,
		sittings: course.sittings.map((s) => s.chatId),
		progress: courseProgress(courseViews(ports, course)),
	}));
}

/** The course view of a chat's course, for the plan window. */
export function courseViewOfChat(chatId: string): CourseView | null {
	const course = courseOfChat(coursePorts(), chatId);
	return course ? readCourseView(course.id) : null;
}

/** New chat continues an earlier sitting (the Continue card; chat creation). */
export function continueCourse(newChatId: string, fromChatId: string): CourseRecord | null {
	return startCourseSitting(coursePorts(), newChatId, fromChatId);
}

/** §9.1: make a course from one session (with a reconstructed hand-off when it was never closed). */
export function adoptChat(chatId: string): CourseRecord | null {
	return ensureCourseForChat(coursePorts(), chatId, { reconstruct: true });
}

export function renameCourse(courseId: string, title: string): CourseRecord | null {
	const course = stores.courseStore.get(courseId);
	if (!course || !title.trim()) return null;
	const next = { ...course, title: title.trim().slice(0, 200), updatedAt: new Date().toISOString() };
	stores.courseStore.save(next);
	return next;
}

export function editDigest(courseId: string, digest: string): CourseRecord | null {
	const course = stores.courseStore.get(courseId);
	return course ? saveDigest(coursePorts(), course, digest.trim()) : null;
}

export function removeFromCourse(courseId: string, chatId: string): CourseRecord | null {
	return ungroupChat(coursePorts(), courseId, chatId);
}

export function refreshSitting(chatId: string): void {
	syncSitting(coursePorts(), chatId);
}

// ─── Grouping (§9.2) ─────────────────────────────────────────────────────────

export class CourseGroupError extends Error {}

function groupInputs(courseId: string | null, chatIds: readonly string[]) {
	const course = courseId ? stores.courseStore.get(courseId) : null;
	if (courseId && !course) throw new CourseGroupError(`No course ${courseId}.`);
	const chats = chatIds.map((id) => stores.chatStore.getChat(id));
	const missing = chatIds.filter((_, i) => !chats[i]);
	if (missing.length) throw new CourseGroupError(`No session ${missing.join(", ")}.`);
	const fresh = (chats as ChatRecord[]).filter((chat) => !course?.sittings.some((s) => s.chatId === chat.id));
	if (!course && fresh.length < 1) throw new CourseGroupError("Pick at least one session.");
	return { course, chats: fresh };
}

/**
 * The proposed matching table for grouping `chatIds` (into `courseId`, or a
 * new course). An existing course contributes its map as one more source,
 * keyed by the course id, so its nodes keep their ids.
 */
export function proposeGroup(courseId: string | null, chatIds: readonly string[]): { rows: NodeMatchRow[]; chats: Array<{ chatId: string; title: string; nodes: number; courseId?: string }> } {
	const { course, chats } = groupInputs(courseId, chatIds);
	const sources = [
		...(course ? [{ chatId: course.id, tree: course.map }] : []),
		...chats.map((chat) => ({ chatId: chat.id, tree: chat.tree })),
	];
	const rows = proposeNodeMatches(sources).map((row) => {
		// An existing course node keeps its id.
		const own = course ? row.from[course.id] : undefined;
		return own ? { ...row, courseNodeId: own } : row;
	});
	return {
		rows,
		chats: chats.map((chat) => ({
			chatId: chat.id,
			title: chat.title,
			nodes: chat.tree?.nodes.length ?? 0,
			...(courseOfChat(coursePorts(), chat.id) ? { courseId: courseOfChat(coursePorts(), chat.id)!.id } : {}),
		})),
	};
}

/**
 * Apply a confirmed matching table: chats already in another course move
 * (their old course loses them), every adopted chat becomes a sitting in
 * date order, aliases map each old node onto its course node. Never edits
 * evidence, reviews or the adopted chats' messages.
 */
export function applyGroup(input: { courseId: string | null; chatIds: readonly string[]; rows: readonly NodeMatchRow[]; title?: string }): CourseRecord {
	const ports = coursePorts();
	const { course: existing, chats } = groupInputs(input.courseId, input.chatIds);
	const sources = [
		...(existing ? [{ chatId: existing.id, tree: existing.map }] : []),
		...chats.map((chat) => ({ chatId: chat.id, tree: chat.tree })),
	];
	const problems = matchTableProblems(input.rows, sources);
	if (problems.length) throw new CourseGroupError(problems.join(" "));
	// The existing course map is the base: its nodes keep their ids, and its own entries alias nothing.
	const merged = mapFromMatches(input.rows, sources, existing?.map);
	const map = merged.map;
	const aliases = Object.fromEntries(Object.entries(merged.aliases).filter(([key]) => !existing || !key.startsWith(`${existing.id}#`)));
	const now = new Date().toISOString();
	// Move chats out of other courses first.
	for (const chat of chats) {
		const other = courseOfChat(ports, chat.id);
		if (other && other.id !== existing?.id) ungroupChat(ports, other.id, chat.id);
	}
	let course: CourseRecord = existing ?? emptyCourse({ title: input.title?.trim() || chats[0]!.title, nowIso: now });
	course = { ...course, map, aliases: { ...course.aliases, ...aliases }, updatedAt: now };
	if (input.title?.trim()) course = { ...course, title: input.title.trim() };
	for (const chat of [...chats].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
		const source = sourceFromChat(chat);
		if (source && !course.sources.some((s) => s.chatId === chat.id)) course = { ...course, sources: [...course.sources, source] };
		let sitting = sittingFromChat(chat);
		if (!sitting.handoff && (chat.kind ?? "teach") === "teach") {
			// §9.1 step 4, per adopted teach chat: a reconstructed hand-off.
			const keys = courseItemKeys([course]);
			const nodes = new Set((chat.tree?.nodes ?? []).map((n) => keys.key(chat.id, n.id).nodeId));
			const views = courseViews(ports, course).filter((v) => nodes.has(v.id));
			sitting = { ...sitting, handoff: reconstructedHandoff({ title: chat.title, views }), handoffSource: "reconstructed" };
		}
		course = upsertSitting(course, sitting, now);
	}
	stores.courseStore.save(course);
	for (const chat of chats) stores.chatStore.saveSettings(chat.id, { ...stores.chatStore.getChat(chat.id)?.settings, courseId: course.id });
	return course;
}
