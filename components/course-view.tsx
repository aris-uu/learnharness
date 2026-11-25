"use client";
/**
 * THE COURSE PAGE (docs/course-plans-plan.md §7, §9): one course's sources,
 * editable digest, full map with node states, and its sittings; plus the
 * grouping flow (pick sessions → review the matching table → confirm).
 * Nothing is written until the learner confirms.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { stashContinueDraft } from "@/components/math-mode";
import type { ChatCourseView } from "@/components/plan-block";

type NodeState = ChatCourseView["nodes"][number]["state"];
const STATE_LABEL: Record<NodeState, string> = { done: "Done", stale: "Stale", started: "Started", later: "Later" };
const STATE_MARK: Record<NodeState, string> = { done: "✓", stale: "~", started: "…", later: "·" };
const GOAL_MARK: Record<string, string> = { met: "✓", partial: "◐", unmet: "✗", open: "○" };

export interface CourseSource { chatId: string; messageId: string; text: string; attachments: string[] }
export type CoursePageView = ChatCourseView & {
	course: ChatCourseView["course"] & { createdAt: string; updatedAt: string; sources: CourseSource[] };
};

async function send(url: string, init: RequestInit): Promise<{ ok: boolean; body: Record<string, unknown> }> {
	const res = await fetch(url, { ...init, headers: { "content-type": "application/json" } });
	const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	return { ok: res.ok, body };
}

export function CoursePage({ initial }: { initial: CoursePageView }) {
	const router = useRouter();
	const [view, setView] = useState(initial);
	const [title, setTitle] = useState(initial.course.title);
	const [digest, setDigest] = useState(initial.course.digest ?? "");
	const [saved, setSaved] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [grouping, setGrouping] = useState(false);
	const id = view.course.id;

	const patch = async (body: { title?: string; digest?: string }, what: string) => {
		setError(null);
		const res = await send(`/api/courses/${id}`, { method: "PATCH", body: JSON.stringify(body) });
		if (!res.ok) { setError(String(res.body.error ?? "Could not save.")); return; }
		setView(res.body as unknown as CoursePageView);
		setSaved(what);
		setTimeout(() => setSaved(null), 1500);
	};
	const ungroup = async (chatId: string) => {
		if (!window.confirm("Remove this session from the course? Its evidence and messages stay as they are.")) return;
		const res = await send(`/api/courses/${id}?chatId=${encodeURIComponent(chatId)}`, { method: "DELETE" });
		if (!res.ok) { setError(String(res.body.error ?? "Could not remove.")); return; }
		if (!res.body.courseId) { router.push("/course"); return; }
		router.refresh();
		const next = await fetch(`/api/courses/${id}`).then((r) => r.json());
		setView(next as CoursePageView);
	};
	const last = view.sittings.at(-1);
	const nextSitting = () => {
		if (!last) return;
		if (!stashContinueDraft({ text: `Next sitting of "${view.course.title}".`, continuesFrom: last.chatId })) { setError("Could not open the new session draft."); return; }
		router.push("/chat/new");
	};
	const byState = useMemo(() => {
		const groups: Record<NodeState, ChatCourseView["nodes"]> = { started: [], stale: [], later: [], done: [] };
		for (const node of view.nodes) groups[node.state].push(node);
		return groups;
	}, [view.nodes]);

	return (
		<div className="mx-auto w-full max-w-4xl px-6 py-8" data-testid="course-page">
			<div className="flex items-center gap-3">
				<input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() && title !== view.course.title && patch({ title }, "title")}
					aria-label="Course title" data-testid="course-title"
					className="min-w-0 flex-1 bg-transparent font-serif text-2xl outline-none focus:underline" />
				<button type="button" onClick={nextSitting} disabled={!last} data-testid="course-next-sitting"
					className="rounded-full bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
					Start the next sitting
				</button>
			</div>
			<p className="mt-1 text-sm text-muted-foreground">
				{view.progress.done}/{view.progress.total} nodes done · {view.sittings.length} sitting{view.sittings.length === 1 ? "" : "s"}
				{saved && <span className="ml-2 text-primary">saved {saved}</span>}
			</p>
			{error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}

			<section className="mt-6">
				<h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Map</h2>
				{view.nodes.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No map yet: the first sitting&apos;s plan becomes the course map.</p> : (
					<div className="mt-2 grid gap-4 sm:grid-cols-2">
						{(Object.keys(byState) as NodeState[]).filter((state) => byState[state].length).map((state) => (
							<div key={state}>
								<h3 className="text-sm font-medium">{STATE_LABEL[state]} ({byState[state].length})</h3>
								<ul className="mt-1 space-y-0.5 text-sm">
									{byState[state].map((node) => (
										<li key={node.id} data-testid={`course-node-${node.id}`} data-state={node.state} className={cn(node.state === "later" && "text-muted-foreground")}>
											<span aria-hidden className="mr-1.5">{STATE_MARK[node.state]}</span>{node.title}
											{node.habits.length > 0 && <span className="ml-1 text-xs text-muted-foreground">({node.habits.join(", ")})</span>}
										</li>
									))}
								</ul>
							</div>
						))}
					</div>
				)}
			</section>

			<section className="mt-6">
				<h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Digest</h2>
				<p className="mt-1 text-xs text-muted-foreground">What every sitting starts from instead of the raw sources: the outline or every problem, plus the context. The tutor writes it once; edit it freely.</p>
				<textarea value={digest} onChange={(e) => setDigest(e.target.value)} rows={8} data-testid="course-digest"
					className="mt-2 w-full rounded-lg border bg-background p-2 font-mono text-xs" placeholder="No digest yet." />
				<button type="button" onClick={() => patch({ digest }, "digest")} disabled={digest === (view.course.digest ?? "")}
					className="mt-1 rounded-md border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50">Save digest</button>
			</section>

			<section className="mt-6">
				<h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Sources</h2>
				{view.course.sources.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">None recorded.</p> : view.course.sources.map((source, i) => (
					<details key={`${source.chatId}-${source.messageId}`} className="mt-2 rounded-lg border p-2 text-sm">
						<summary className="cursor-pointer">Source {i + 1}{source.attachments.length ? ` · ${source.attachments.length} attachment${source.attachments.length === 1 ? "" : "s"}` : ""}</summary>
						<pre className="mt-2 whitespace-pre-wrap font-mono text-xs">{source.text}</pre>
						{source.attachments.map((path) => <p key={path} className="font-mono text-xs text-muted-foreground">{path}</p>)}
					</details>
				))}
			</section>

			<section className="mt-6">
				<div className="flex items-center justify-between">
					<h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Sittings</h2>
					<button type="button" onClick={() => setGrouping((g) => !g)} data-testid="course-add-sessions" className="rounded-md border px-2 py-1 text-xs hover:bg-accent">
						{grouping ? "Cancel" : "Add earlier sessions"}
					</button>
				</div>
				{grouping && <GroupSessions courseId={id} onDone={(courseId) => { setGrouping(false); router.push(`/course/${courseId}`); router.refresh(); }} />}
				<ol className="mt-2 space-y-3">
					{view.sittings.map((sitting, i) => (
						<li key={sitting.chatId} className="rounded-lg border p-3 text-sm" data-testid={`course-sitting-${sitting.chatId}`}>
							<div className="flex items-center gap-2">
								<span className="text-muted-foreground">{i + 1}.</span>
								<Link href={`/chat/${sitting.chatId}`} className="font-medium hover:underline">{sitting.title}</Link>
								<span className="text-xs text-muted-foreground">
									{sitting.startedAt.slice(0, 10)}{sitting.budgetMin ? ` · ${sitting.budgetMin} min` : ""}{sitting.closedAt ? " · closed" : " · open"}{sitting.kind && sitting.kind !== "teach" ? ` · ${sitting.kind}` : ""}
								</span>
								<button type="button" onClick={() => ungroup(sitting.chatId)} className="ml-auto text-xs text-muted-foreground hover:text-destructive">Remove</button>
							</div>
							{sitting.goals.length > 0 && (
								<ul className="mt-1 space-y-0.5 text-muted-foreground">
									{sitting.goals.map((g) => <li key={g.id}>{GOAL_MARK[g.status] ?? "○"} {g.text}</li>)}
								</ul>
							)}
							{sitting.handoff && (
								<details className="mt-1">
									<summary className="cursor-pointer text-xs text-muted-foreground">Hand-off{sitting.handoffSource === "reconstructed" ? " (reconstructed from the record)" : ""}</summary>
									<p className="mt-1 whitespace-pre-wrap text-xs">{sitting.handoff}</p>
								</details>
							)}
						</li>
					))}
				</ol>
			</section>
		</div>
	);
}

interface MatchRow { courseNodeId: string; title: string; from: Record<string, string>; action: "merge" | "separate" | "drop"; reason: string }
interface SessionRow { id: string; title: string; kind: string; createdAt: string; settings?: { courseId?: string } }

/**
 * §9.2: pick sessions, review the proposed node matches, confirm. With a
 * courseId the picked sessions join that course; without one they form a
 * new course.
 */
export function GroupSessions({ courseId, onDone }: { courseId?: string; onDone: (courseId: string) => void }) {
	const [sessions, setSessions] = useState<SessionRow[] | null>(null);
	const [picked, setPicked] = useState<string[]>([]);
	const [rows, setRows] = useState<MatchRow[] | null>(null);
	const [titles, setTitles] = useState<Record<string, string>>({});
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		fetch("/api/chats").then((r) => r.json()).then((body: { chats?: SessionRow[] }) => setSessions((body.chats ?? []).filter((c) => c.kind !== "practice"))).catch(() => setSessions([]));
	}, []);
	const candidates = (sessions ?? []).filter((s) => !courseId || s.settings?.courseId !== courseId);
	const toggle = (id: string) => { setRows(null); setPicked((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p, id]); };
	const propose = async () => {
		setError(null); setBusy(true);
		const res = await send("/api/courses", { method: "POST", body: JSON.stringify({ action: "propose", courseId, chatIds: picked }) });
		setBusy(false);
		if (!res.ok) { setError(String(res.body.error ?? "Could not propose a table.")); return; }
		setRows(res.body.rows as MatchRow[]);
		setTitles(Object.fromEntries((res.body.chats as Array<{ chatId: string; title: string }>).map((c) => [c.chatId, c.title])));
	};
	const confirm = async () => {
		if (!rows) return;
		setError(null); setBusy(true);
		const res = await send("/api/courses", { method: "POST", body: JSON.stringify({ action: "group", courseId, chatIds: picked, rows, ...(name.trim() ? { title: name.trim() } : {}) }) });
		setBusy(false);
		if (!res.ok) { setError(String(res.body.error ?? "Could not group.")); return; }
		onDone(String(res.body.courseId));
	};
	const edit = (i: number, change: Partial<MatchRow>) => setRows((r) => r && r.map((row, j) => j === i ? { ...row, ...change } : row));
	const sourceName = (id: string) => id === courseId ? "this course" : titles[id] ?? id;

	return (
		<div className="mt-3 rounded-lg border p-3 text-sm" data-testid="group-sessions">
			{sessions === null ? <p className="text-muted-foreground">Loading sessions…</p> : (
				<>
					<p className="text-xs text-muted-foreground">Pick the sessions that belong together. Their nodes are matched by title; you confirm every row. Evidence, reviews and messages are never edited: old node ids get aliases.</p>
					<ul className="mt-2 max-h-56 space-y-0.5 overflow-y-auto">
						{candidates.map((s) => (
							<li key={s.id}>
								<label className="flex items-center gap-2">
									<input type="checkbox" checked={picked.includes(s.id)} onChange={() => toggle(s.id)} data-testid={`group-pick-${s.id}`} />
									<span>{s.title}</span>
									<span className="text-xs text-muted-foreground">{s.createdAt.slice(0, 10)}{s.kind !== "teach" ? ` · ${s.kind}` : ""}{s.settings?.courseId ? " · in a course (moves)" : ""}</span>
								</label>
							</li>
						))}
					</ul>
					{!courseId && <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Course title (defaults to the first session's)" className="mt-2 w-full rounded-md border bg-background px-2 py-1" />}
					<button type="button" onClick={propose} disabled={busy || picked.length === 0} data-testid="group-propose" className="mt-2 rounded-md border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50">Match nodes</button>
				</>
			)}
			{rows && (
				<div className="mt-3">
					<table className="w-full text-xs" data-testid="group-table">
						<thead className="text-left text-muted-foreground"><tr><th className="py-1">Course node</th><th>Title</th><th>From</th><th>Action</th></tr></thead>
						<tbody>
							{rows.map((row, i) => (
								<tr key={i} className={cn("border-t align-top", row.action === "drop" && "opacity-50")}>
									<td className="py-1 pr-2"><input value={row.courseNodeId} onChange={(e) => edit(i, { courseNodeId: e.target.value })} className="w-36 rounded border bg-background px-1 font-mono" /></td>
									<td className="pr-2"><input value={row.title} onChange={(e) => edit(i, { title: e.target.value })} className="w-full rounded border bg-background px-1" /></td>
									<td className="pr-2">{Object.entries(row.from).map(([chat, node]) => <div key={chat}><span className="text-muted-foreground">{sourceName(chat)}:</span> <span className="font-mono">{node}</span></div>)}<div className="text-muted-foreground">{row.reason}</div></td>
									<td>
										<select value={row.action} onChange={(e) => edit(i, { action: e.target.value as MatchRow["action"] })} className="rounded border bg-background">
											{Object.keys(row.from).length > 1 && <option value="merge">merge</option>}
											<option value="separate">separate</option>
											<option value="drop">drop</option>
										</select>
									</td>
								</tr>
							))}
						</tbody>
					</table>
					<button type="button" onClick={confirm} disabled={busy} data-testid="group-confirm" className="mt-2 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50">Confirm and group</button>
				</div>
			)}
			{error && <p role="alert" className="mt-2 text-destructive">{error}</p>}
		</div>
	);
}

/** The course list (/course): every course with its progress, and the grouping flow for a new one. */
export function CourseList({ courses }: { courses: Array<{ id: string; title: string; updatedAt: string; sittings: string[]; progress: { done: number; total: number } }> }) {
	const router = useRouter();
	const [grouping, setGrouping] = useState(false);
	return (
		<div className="mx-auto w-full max-w-4xl px-6 py-8" data-testid="course-list">
			<div className="flex items-center justify-between">
				<h1 className="font-serif text-2xl">Courses</h1>
				<button type="button" onClick={() => setGrouping((g) => !g)} className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">{grouping ? "Cancel" : "Group sessions into a course"}</button>
			</div>
			<p className="mt-1 text-sm text-muted-foreground">A course keeps the whole map and the sources across sittings. Every time-boxed session starts one; continuing a sitting adds to it.</p>
			{grouping && <GroupSessions onDone={(id) => router.push(`/course/${id}`)} />}
			<ul className="mt-4 space-y-2">
				{courses.length === 0 && <li className="text-sm text-muted-foreground">No courses yet.</li>}
				{courses.map((course) => (
					<li key={course.id} className="rounded-lg border p-3 text-sm">
						<Link href={`/course/${course.id}`} className="font-medium hover:underline">{course.title}</Link>
						<span className="ml-2 text-xs text-muted-foreground">{course.progress.done}/{course.progress.total} done · {course.sittings.length} sitting{course.sittings.length === 1 ? "" : "s"} · {course.updatedAt.slice(0, 10)}</span>
					</li>
				))}
			</ul>
		</div>
	);
}
