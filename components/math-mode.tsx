"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, PauseIcon, PlayIcon, RepeatIcon, SigmaIcon, TargetIcon, TimerIcon, Undo2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import type { PlanNode, PlanTree, SessionGoal, TeachingProfile, TimeboxState } from "@/src/core";
import { evidenceFromMessages, isTimeboxOption, sessionClock, TIMEBOX_EXTEND_MIN, MATH_STATUS_LABELS, nodeStatus, prerequisiteChain, TIMEBOX_OPTIONS } from "@/src/core";
import { cn } from "@/lib/utils";

const DRAFT_KEY = "lh.draft-math-mode";

export function readDraftMathMode(): boolean {
	try { return window.localStorage.getItem(DRAFT_KEY) === "1"; }
	catch { return false; }
}

function writeDraftMathMode(on: boolean): void {
	try {
		if (on) window.localStorage.setItem(DRAFT_KEY, "1");
		else window.localStorage.removeItem(DRAFT_KEY);
	} catch { /* The toggle still works for this page. */ }
}

function MathPill({ on, disabled, onClick }: { on: boolean; disabled?: boolean; onClick: () => void }) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={on}
			disabled={disabled}
			data-testid="math-mode-toggle"
			title={on ? "Math mode is on: written answers, earned definitions, mastery gates" : "Turn on Math mode for hard mathematics"}
			onClick={onClick}
			className={cn(
				"lh-no-drag flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium uppercase tracking-wide transition-colors disabled:cursor-default disabled:opacity-50",
				on ? "border-primary text-primary" : "border-border/80 text-muted-foreground hover:border-border hover:text-foreground",
			)}
		>
			<SigmaIcon className="size-3.5" aria-hidden />
			Math mode
		</button>
	);
}

/** The new-session toggle, remembered for the next draft. */
export function DraftMathModeToggle() {
	const [on, setOn] = useState(false);
	useEffect(() => { setOn(readDraftMathMode()); }, []);
	return <MathPill on={on} onClick={() => { writeDraftMathMode(!on); setOn(!on); }} />;
}

// ─── Time box (2026-11-20, docs/timeboxed-sessions-plan.md) ─────────────────

const DRAFT_TIMEBOX_KEY = "lh.draft-timebox";
const DRAFT_CONSOLIDATE_KEY = "lh.draft-consolidate";

export function readDraftTimebox(): number | null {
	try { const n = Number(window.localStorage.getItem(DRAFT_TIMEBOX_KEY)); return isTimeboxOption(n) ? n : null; }
	catch { return null; }
}

// ─── Continue in a new session (owner, 2026-11-21) ──────────────────────────
// The closed sitting's Continue opens the new-session draft with the hand-off
// typed in, instead of creating and sending at once, so settings can change
// first. The draft takes the stash once on mount; any send from that draft
// keeps the continuesFrom link, and leaving it drops the link.
const CONTINUE_DRAFT_KEY = "lh.continue-draft";

export interface ContinueDraft { text: string; continuesFrom: string }

export function stashContinueDraft(draft: ContinueDraft): boolean {
	try { globalThis.sessionStorage.setItem(CONTINUE_DRAFT_KEY, JSON.stringify(draft)); return true; }
	catch { return false; }
}

/** Read and clear the stash: one draft screen visit takes it. */
export function takeContinueDraft(): ContinueDraft | null {
	try {
		const raw = globalThis.sessionStorage.getItem(CONTINUE_DRAFT_KEY);
		globalThis.sessionStorage.removeItem(CONTINUE_DRAFT_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<ContinueDraft>;
		return typeof parsed.text === "string" && typeof parsed.continuesFrom === "string" ? { text: parsed.text, continuesFrom: parsed.continuesFrom } : null;
	} catch { return null; }
}

function writeDraftTimebox(min: number | null): void {
	try {
		if (min) window.localStorage.setItem(DRAFT_TIMEBOX_KEY, String(min));
		else window.localStorage.removeItem(DRAFT_TIMEBOX_KEY);
	} catch { /* The choice still works for this page. */ }
}

const PILL = "lh-no-drag flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium uppercase tracking-wide transition-colors";

/** The time box picker: a pill that opens a small menu in the app's own style. */
function TimeboxPill({ value, disabled, onChange, label, up }: {
	value: number | null;
	disabled?: boolean;
	onChange: (min: number | null) => void;
	label?: string;
	/** Open the menu above the pill (the composer row) instead of below (the top bar). */
	up?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const dismiss = (event: PointerEvent) => {
			if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
		};
		const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
		document.addEventListener("pointerdown", dismiss);
		document.addEventListener("keydown", escape);
		return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
	}, [open]);
	const choices: Array<number | null> = [null, ...TIMEBOX_OPTIONS];
	return (
		<div ref={rootRef} className="lh-no-drag relative shrink-0">
			<button
				type="button"
				data-testid="timebox-select"
				aria-label="Time box"
				aria-haspopup="menu"
				aria-expanded={open}
				disabled={disabled}
				title="Time box: one sitting of this many active minutes. The tutor sizes the goals to it and closes the session when it runs out."
				onClick={() => setOpen(!open)}
				className={cn(PILL, "cursor-pointer disabled:cursor-default disabled:opacity-50",
					value ? "border-primary text-primary" : "border-border/80 text-muted-foreground hover:border-border hover:text-foreground")}
			>
				<TimerIcon className="size-3.5" aria-hidden />
				<span className="tabular-nums">{label ? `${label} ` : ""}{value ? `${value} min` : "Time box"}</span>
				<ChevronDownIcon className={cn("size-3 transition-transform", open && "rotate-180")} aria-hidden />
			</button>
			{open && (
				<div role="menu" aria-label="Time box" data-testid="timebox-menu"
					className={cn("absolute left-0 z-50 w-36 rounded-lg border bg-card p-1 shadow-lg", up ? "bottom-full mb-1" : "top-full mt-1")}>
					{choices.map((min) => (
						<button
							key={min ?? "off"}
							type="button"
							role="menuitemradio"
							aria-checked={value === min}
							onClick={() => { setOpen(false); if (min !== value) onChange(min); }}
							className={cn("flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
								value === min ? "text-primary" : "text-foreground")}
						>
							<span className="tabular-nums">{min ? `${min} min` : "No time box"}</span>
							{value === min && <CheckIcon className="size-3.5" aria-hidden />}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

/** The new-session time box, remembered for the next draft. */
export function DraftTimeboxSelect() {
	const [value, setValue] = useState<number | null>(null);
	useEffect(() => { setValue(readDraftTimebox()); }, []);
	return <TimeboxPill up value={value} onChange={(min) => { writeDraftTimebox(min); setValue(min); }} />;
}

/** The sitting's settings, refetched as the record grows (goals and the close are written by tools). */
export function useSittingState(chatId: string, revision: number) {
	const [state, setState] = useState<(TimeboxState & { timeboxMin?: number }) | null>(null);
	useEffect(() => {
		let live = true;
		fetch(`/api/chats/${chatId}`)
			.then((res) => (res.ok ? res.json() : null))
			.then((chat: { settings?: { timeboxMin?: number; timebox?: TimeboxState } } | null) => {
				if (live) setState(chat?.settings?.timeboxMin ? { ...chat.settings.timebox, timeboxMin: chat.settings.timeboxMin } : null);
			})
			.catch(() => {});
		return () => { live = false; };
	}, [chatId, revision]);
	return state;
}

const GOAL_MARK: Record<SessionGoal["status"], string> = { open: "○", met: "●", partial: "◐", unmet: "✕" };

/** The session's time box: budget picker, clock, goals, Break and +15. */
export function SessionTimeboxSelect({ chatId, messages }: { chatId: string; messages: readonly unknown[] }) {
	const [revision, setRevision] = useState(0);
	const fetched = useSittingState(chatId, messages.length + revision * 100_000);
	const [saving, setSaving] = useState(false);
	const [open, setOpen] = useState(false);
	const [now, setNow] = useState(() => Date.now());
	const value = fetched?.timeboxMin ?? null;
	useEffect(() => {
		if (!value) return;
		const timer = window.setInterval(() => setNow(Date.now()), 30_000);
		return () => window.clearInterval(timer);
	}, [value]);
	const patch = async (body: Record<string, unknown>) => {
		setSaving(true);
		try {
			await fetch(`/api/chats/${chatId}/settings`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
			setRevision((r) => r + 1);
		} finally { setSaving(false); }
	};
	const clock = value ? sessionClock(messages, value, now, fetched ?? {}) : null;
	const goals = fetched?.goals ?? [];
	const closed = Boolean(fetched?.closedAt);
	return (
		<div className="relative flex shrink-0 items-center gap-1">
			<TimeboxPill value={value} disabled={saving || closed} onChange={(min) => void patch({ timeboxMin: min })}
				label={clock ? `${clock.usedMin} /` : undefined} />
			{clock && !closed && (
				<>
					<button type="button" data-testid="timebox-break" disabled={saving}
						onClick={() => void patch({ timeboxAction: clock.onBreak ? "resume" : "break" })}
						title={clock.onBreak ? "End the break: the clock runs again" : "Take a break: the clock pauses"}
						className={cn(PILL, "cursor-pointer", clock.onBreak ? "border-primary text-primary" : "border-border/80 text-muted-foreground hover:text-foreground")}>
						{clock.onBreak ? <PlayIcon className="size-3.5" aria-hidden /> : <PauseIcon className="size-3.5" aria-hidden />}
						{clock.onBreak ? "Resume" : "Break"}
					</button>
					{!fetched?.extendedMin && clock.phase !== "teach" && (
						<button type="button" data-testid="timebox-extend" disabled={saving} onClick={() => void patch({ timeboxAction: "extend" })}
							title={`Extend this sitting once by ${TIMEBOX_EXTEND_MIN} minutes`}
							className={cn(PILL, "cursor-pointer border-border/80 text-muted-foreground hover:text-foreground")}>
							+{TIMEBOX_EXTEND_MIN}
						</button>
					)}
				</>
			)}
			{goals.length > 0 && (
				<button type="button" data-testid="timebox-goals" aria-expanded={open} onClick={() => setOpen(!open)}
					className={cn(PILL, "cursor-pointer border-border/80 text-muted-foreground hover:text-foreground")}>
					<TargetIcon className="size-3.5" aria-hidden />
					Goals {goals.filter((g) => g.status === "met").length}/{goals.length}
				</button>
			)}
			{open && goals.length > 0 && (
				<div role="dialog" className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border bg-popover p-3 text-sm shadow-lg">
					<ul className="space-y-1.5">
						{goals.map((g) => (
							<li key={g.id} className="flex gap-2"><span aria-label={g.status}>{GOAL_MARK[g.status]}</span><span>{g.text}</span></li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

/** Replaces the composer once the tutor has closed the sitting. */
export function ClosedSittingCard({ chatId, title, state, profile }: {
	chatId: string;
	title: string;
	state: TimeboxState & { timeboxMin?: number };
	profile: TeachingProfile | null;
}) {
	const router = useRouter();
	const [error, setError] = useState(false);
	const goals = state.goals ?? [];
	// The course seed (server side, docs/course-plans-plan.md §5) carries the
	// sources, the full map, the hand-offs and the carried-over goals, so the
	// prompt only names the sitting; the learner can add what today is for.
	const prompt = `Next sitting of "${title}".`;
	// Open the draft prefilled, with the draft toggles preset from this
	// sitting (still changeable there); nothing is created until send.
	const start = () => {
		setError(false);
		if (!stashContinueDraft({ text: prompt, continuesFrom: chatId })) { setError(true); return; }
		writeDraftMathMode(profile === "math");
		writeDraftTimebox(state.timeboxMin && isTimeboxOption(state.timeboxMin) ? state.timeboxMin : null);
		router.push("/chat/new");
	};
	return (
		<div data-testid="closed-sitting" className="pointer-events-auto mb-4 rounded-2xl border bg-card p-4 shadow-lg">
			<p className="text-sm font-medium">This sitting is closed.</p>
			{goals.length > 0 && (
				<ul className="mt-2 space-y-1 text-sm text-muted-foreground">
					{goals.map((g) => <li key={g.id}>{GOAL_MARK[g.status]} {g.text}</li>)}
				</ul>
			)}
			<button type="button" data-testid="continue-sitting" onClick={start}
				className="mt-3 rounded-full bg-primary px-3 py-1 text-sm font-medium text-primary-foreground disabled:opacity-50">
				Start the next sitting
			</button>
			{error && <p role="alert" className="mt-2 text-sm text-destructive">Could not open the new session draft. Try again.</p>}
		</div>
	);
}

export function readDraftConsolidate(): boolean {
	try { return window.localStorage.getItem(DRAFT_CONSOLIDATE_KEY) === "1"; }
	catch { return false; }
}

/** The review draft's switch: consolidate young items, or review mature ones. */
export function DraftConsolidateToggle() {
	const [on, setOn] = useState(false);
	useEffect(() => { setOn(readDraftConsolidate()); }, []);
	const flip = () => {
		try { if (on) window.localStorage.removeItem(DRAFT_CONSOLIDATE_KEY); else window.localStorage.setItem(DRAFT_CONSOLIDATE_KEY, "1"); } catch { /* page-only */ }
		setOn(!on);
	};
	return (
		<button
			type="button"
			role="switch"
			aria-checked={on}
			data-testid="consolidate-toggle"
			title={on ? "Consolidate: re-teach items still in learning (stability under 21 days)" : "Review: test mature items only (stability 21 days or more)"}
			onClick={flip}
			className={cn(PILL, "cursor-pointer", on ? "border-primary text-primary" : "border-border/80 text-muted-foreground hover:border-border hover:text-foreground")}
		>
			<RepeatIcon className="size-3.5" aria-hidden />
			{on ? "Consolidate" : "Review mature"}
		</button>
	);
}

/** The session's profile, read from its own record. */
export function useSessionProfile(chatId: string) {
	const [profile, setProfile] = useState<TeachingProfile | null>(null);
	useEffect(() => {
		let live = true;
		fetch(`/api/chats/${chatId}`)
			.then((res) => (res.ok ? res.json() : null))
			.then((chat: { settings?: { profile?: TeachingProfile } } | null) => { if (live) setProfile(chat?.settings?.profile ?? null); })
			.catch(() => {});
		return () => { live = false; };
	}, [chatId]);
	return [profile, setProfile] as const;
}

/** Takes effect on the next turn, because agents are rebuilt per turn. */
export function SessionMathModeToggle({ chatId, profile, onChange }: {
	chatId: string;
	profile: TeachingProfile | null;
	onChange: (profile: TeachingProfile | null) => void;
}) {
	const [saving, setSaving] = useState(false);
	const on = profile === "math";
	const toggle = async () => {
		setSaving(true);
		try {
			const res = await fetch(`/api/chats/${chatId}/settings`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ profile: on ? null : "math" }),
			});
			if (res.ok) onChange(on ? null : "math");
		} finally { setSaving(false); }
	};
	return <MathPill on={on} disabled={saving} onClick={() => void toggle()} />;
}

/** Lists the current node's prerequisites, nearest first, with their evidence. */
export function GoBackMenu({ tree, current, messages, disabled, onPick }: {
	tree: PlanTree;
	current: string | null;
	messages: readonly unknown[];
	disabled?: boolean;
	onPick: (node: PlanNode) => void;
}) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const items = useMemo(() => {
		if (!current) return [];
		const evidence = evidenceFromMessages(messages);
		return prerequisiteChain(tree, current).flatMap((id) => {
			const node = tree.nodes.find((candidate) => candidate.id === id);
			return node ? [{ node, status: nodeStatus(id, evidence) }] : [];
		});
	}, [tree, current, messages]);
	useEffect(() => {
		if (!open) return;
		const dismiss = (event: PointerEvent) => {
			if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
		};
		document.addEventListener("pointerdown", dismiss);
		return () => document.removeEventListener("pointerdown", dismiss);
	}, [open]);
	if (items.length === 0) return null;
	return (
		<div ref={rootRef} className="lh-no-drag relative shrink-0">
			<button
				type="button"
				data-testid="go-back-button"
				aria-haspopup="menu"
				aria-expanded={open}
				disabled={disabled}
				title="Go back to a prerequisite"
				onClick={() => setOpen(!open)}
				className="flex cursor-pointer items-center gap-1.5 rounded-full border border-border/80 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:border-border hover:text-foreground disabled:cursor-default disabled:opacity-50"
			>
				<Undo2Icon className="size-3.5" aria-hidden />
				Go back
			</button>
			{open && (
				<div role="menu" aria-label="Prerequisites" data-testid="go-back-menu" className="absolute right-0 top-full z-50 mt-1 max-h-[60vh] w-72 overflow-y-auto rounded-lg border bg-card p-1 shadow-lg">
					{items.map(({ node, status }) => (
						<button
							key={node.id}
							type="button"
							role="menuitem"
							onClick={() => { setOpen(false); onPick(node); }}
							className="flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
						>
							<span className="min-w-0 truncate">{node.title}</span>
							<span className="shrink-0 text-xs text-muted-foreground">{MATH_STATUS_LABELS[status]}</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}
