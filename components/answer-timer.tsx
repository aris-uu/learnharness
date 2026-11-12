"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PauseIcon, PlayIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
	ANSWER_TIMER_KEY_PREFIX,
	ANSWER_TIMER_MAX_AGE_MS,
	answerTimerKey,
	answerTimerSeconds,
	formatElapsed,
	parseStoredAnswerTimer,
	pauseAnswerTimer,
	resetAnswerTimer,
	restoreAnswerTimer,
	resumeAnswerTimer,
	snapshotAnswerTimer,
	startAnswerTimer,
	type AnswerTimerState,
	type StoredAnswerTimer,
} from "@/src/core";

/**
 * The dock's answer timer (owner, 2026-11-12): starts the first time the
 * question is SHOWN (a teach check on reveal), keeps running through a
 * scroll-collapse, stops only on the learner's Pause. The snapshot lives in
 * browser storage keyed by the question's key (its toolCallId, made
 * unique per occurrence when a call id repeats), so a reload resumes it — the time
 * the page was closed never counts. Storage is best-effort: blocked storage
 * just means the timer restarts on reload.
 */

function readStored(questionKey: string): StoredAnswerTimer | undefined {
	try {
		const raw = window.localStorage.getItem(answerTimerKey(questionKey));
		return raw ? parseStoredAnswerTimer(JSON.parse(raw)) : undefined;
	} catch {
		return undefined;
	}
}

function writeStored(questionKey: string, snapshot: StoredAnswerTimer): void {
	try {
		window.localStorage.setItem(answerTimerKey(questionKey), JSON.stringify(snapshot));
	} catch {
		/* storage unavailable — the live timer still works */
	}
}

/** Drop snapshots older than a week (answered or abandoned questions). */
function pruneStored(now: number): void {
	try {
		const storage = window.localStorage;
		for (let i = storage.length - 1; i >= 0; i--) {
			const key = storage.key(i);
			if (!key?.startsWith(ANSWER_TIMER_KEY_PREFIX)) continue;
			let stored: StoredAnswerTimer | undefined;
			try {
				stored = parseStoredAnswerTimer(JSON.parse(storage.getItem(key) ?? "null"));
			} catch {
				stored = undefined;
			}
			if (!stored || now - stored.updatedAt > ANSWER_TIMER_MAX_AGE_MS) storage.removeItem(key);
		}
	} catch {
		/* storage unavailable */
	}
}

/** Mounted timers answer exactly; otherwise the last stored snapshot. */
const liveTimers = new Map<string, () => number>();

/** The elapsed whole seconds for a question — read at dismissal time,
 *  outside the dock. Undefined when the question was never shown. Keyed like
 *  the pending question (`PendingQuestion.key`). */
export function readAnswerTimerSeconds(questionKey: string): number | undefined {
	const live = liveTimers.get(questionKey);
	if (live) return live();
	const stored = readStored(questionKey);
	return stored ? Math.floor(stored.elapsedMs / 1000) : undefined;
}

export interface AnswerTimer {
	/** False until the question is first shown (no snapshot either). */
	started: boolean;
	paused: boolean;
	seconds: number;
	pause(): void;
	resume(): void;
	reset(): void;
	/** Exact elapsed whole seconds right now (submit time). */
	read(): number | undefined;
}

export function useAnswerTimer(questionKey: string, shown: boolean): AnswerTimer {
	const [entry, setEntry] = useState<{ id: string; timer: AnswerTimerState } | null>(null);
	const [now, setNow] = useState(0);
	const timer = entry?.id === questionKey ? entry.timer : null;
	const timerRef = useRef<AnswerTimerState | null>(timer);
	useEffect(() => {
		timerRef.current = timer;
	}, [timer]);

	// Start: a stored snapshot means the question was already shown (a
	// reload) — resume it at once; otherwise wait for the first show.
	useEffect(() => {
		if (timerRef.current) return;
		const t = Date.now();
		const stored = readStored(questionKey);
		let next: AnswerTimerState;
		if (stored) next = restoreAnswerTimer(stored, t);
		else if (shown) {
			pruneStored(t);
			next = startAnswerTimer(t);
			writeStored(questionKey, snapshotAnswerTimer(next, t));
		} else return;
		timerRef.current = next;
		setEntry({ id: questionKey, timer: next });
		setNow(t);
	}, [questionKey, shown]);

	const running = timer !== null && timer.runningSince !== null;
	// Tick + save while running (a reload loses at most a second).
	useEffect(() => {
		if (!running) return;
		const id = window.setInterval(() => {
			const t = Date.now();
			const cur = timerRef.current;
			if (cur) writeStored(questionKey, snapshotAnswerTimer(cur, t));
			setNow(t);
		}, 1000);
		return () => window.clearInterval(id);
	}, [running, questionKey]);

	// Save on page close and unmount; register the live reader for dismissals.
	const started = timer !== null;
	useEffect(() => {
		if (!started) return;
		const save = () => {
			const cur = timerRef.current;
			if (cur) writeStored(questionKey, snapshotAnswerTimer(cur, Date.now()));
		};
		const read = () => {
			const cur = timerRef.current;
			return cur ? answerTimerSeconds(cur, Date.now()) : 0;
		};
		liveTimers.set(questionKey, read);
		window.addEventListener("pagehide", save);
		return () => {
			window.removeEventListener("pagehide", save);
			if (liveTimers.get(questionKey) === read) liveTimers.delete(questionKey);
			save();
		};
	}, [started, questionKey]);

	const apply = useCallback(
		(step: (s: AnswerTimerState, t: number) => AnswerTimerState) => {
			const cur = timerRef.current;
			if (!cur) return;
			const t = Date.now();
			const next = step(cur, t);
			timerRef.current = next;
			writeStored(questionKey, snapshotAnswerTimer(next, t));
			setEntry({ id: questionKey, timer: next });
			setNow(t);
		},
		[questionKey],
	);

	return {
		started,
		paused: timer !== null && timer.runningSince === null,
		seconds: timer ? answerTimerSeconds(timer, now) : 0,
		pause: useCallback(() => apply(pauseAnswerTimer), [apply]),
		resume: useCallback(() => apply(resumeAnswerTimer), [apply]),
		reset: useCallback(() => apply(resetAnswerTimer), [apply]),
		read: useCallback(() => {
			const cur = timerRef.current;
			return cur ? answerTimerSeconds(cur, Date.now()) : undefined;
		}, []),
	};
}

/** The dock's top-right cluster: m:ss, Pause/Resume, Reset. */
export function AnswerTimerControls({ timer }: { timer: AnswerTimer }) {
	if (!timer.started) return null;
	return (
		<div data-testid="answer-timer" className="flex shrink-0 items-center gap-0.5 normal-case tracking-normal">
			<span
				data-testid="answer-timer-value"
				aria-live="off"
				className={cn(
					"mr-1 font-mono text-xs tabular-nums",
					timer.paused ? "text-muted-foreground/60" : "text-muted-foreground",
				)}
			>
				{timer.paused && "paused "}
				{formatElapsed(timer.seconds)}
			</span>
			<Button
				type="button"
				variant="ghost"
				size="icon-xs"
				data-testid="answer-timer-toggle"
				aria-label={timer.paused ? "Resume timer" : "Pause timer"}
				title={timer.paused ? "Resume timer" : "Pause timer"}
				onClick={timer.paused ? timer.resume : timer.pause}
			>
				{timer.paused ? <PlayIcon /> : <PauseIcon />}
			</Button>
			<Button
				type="button"
				variant="ghost"
				size="icon-xs"
				data-testid="answer-timer-reset"
				aria-label="Reset timer"
				title="Reset timer"
				onClick={timer.reset}
			>
				<RotateCcwIcon />
			</Button>
		</div>
	);
}
