"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SigmaIcon, Undo2Icon } from "lucide-react";
import type { PlanNode, PlanTree, TeachingProfile } from "@/src/core";
import { evidenceFromMessages, MATH_STATUS_LABELS, nodeStatus, prerequisiteChain } from "@/src/core";
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
