# Time-boxed sessions: one chat is one sitting

**Status:** built 2026-11-20: phases 0–2 and the analysis in phase 3 (`src/core/session-clock.ts`, `src/agent/tools/timebox.ts`, the Time pill in `components/math-mode.tsx`). Not built: the daily total in the sidebar.
**Motivation:** `D:/projects/learning/reports/fatigue-and-session-length-2026-11-20.md`. These are its findings:

| Finding | Number |
|---|---|
| Unhinted accuracy falls with minutes into a sitting | 65 % (0–30 min) → 58 % (30–60) → **42 % (60–90)** |
| The share of answers needing a hint rises | 16 % → 30 % |
| Natural sittings are already short | median 34 min, longest 115 |
| Sessions are left midway and resumed days later | bilinear forms (stopped mid-question), spherical geometry (two days), point set topology (re-planned 4×, 35 nodes) |
| No math-mode session reached its goal | math mode closes ≈ 3.3 evidence nodes per hour |

The material is mostly forgotten by the time a session is resumed. The fix is to make a session a **sitting**: a time budget chosen up front, a few goals that fit it, and a proper close. The next sitting is then a new session that starts from the close's hand-off.

## 1. What the learner sees

**Starting.** The new-session screen gets a **Time** pill next to **Math mode**: 25 · 45 · **60** · 90 min. The choice is remembered for the next draft. Teach sessions only; practice and review are covered in §7.

The first turn runs as now (the prober), with one addition: the probe ends by proposing **1–3 goals** sized to the budget. Each goal is something checkable, such as "prove that compact ⊂ Hausdorff is closed" or "compute the preservers of B_M". The learner accepts or edits them. Goals are shown at the top of the plan window with a status (open / met / partial).

**During.** The top bar shows a quiet clock: `38 / 60 min`. Only active time counts (§3), so a gap of more than 20 minutes pauses it, and so does a **Break** button. The tutor sees the same clock and paces itself (§4).

**Near the end.** At about 85 % of the budget the tutor stops opening new nodes. At 100 % it starts the close at the next natural boundary, never in the middle of an answer. The learner can **Extend +15 min** once. After that the button suggests a break or a new session instead, because the data says the minutes after an hour are mostly wasted.

**The close (5–8 min, reserved inside the budget):**
1. **Blank-page retrieval, one item per goal.** The goal's statement or proof is written from scratch, with no notes on screen. This is graded evidence like any other answer, and it is the strongest consolidation step in the session.
2. **Goal verdicts**: met / partial / not met, each backed by evidence records.
3. **Hand-off**: a short note in the session covering what holds, what's fragile (named habits), and what's next. An unmet goal becomes the next session's proposed goal.
4. The session becomes **closed**. Its items are already in the memory model, and the first review is about a day later under the existing encoding cap.

**Coming back.** A closed session's composer is replaced by **Continue in a new session**. That creates a new time-boxed session whose probe is seeded with the hand-off, so it is not cold. If an *unclosed* session is reopened more than about 4 hours after its last activity, the tutor opens with a **3-minute recap retrieval** of what was covered, before teaching anything new. That way it doesn't pick up mid-question as if no time had passed.

## 2. Data model

A new optional field on the chat record. The settings route already uses replace-whole writes, so this gets its own writer, like `profile`.

```ts
// src/core/contracts/chat.ts
export interface SessionTimebox {
  budgetMin: number;            // chosen at start: 25 | 45 | 60 | 90
  extendedMin: number;          // 0 or 15 (one extension)
  goals: SessionGoal[];         // set by the `set_goals` tool after the probe
  closingStartedAt?: string;    // ISO; set by `begin_close`
  closedAt?: string;            // ISO; set by `close_session`
  handoff?: string;             // the close's note (markdown)
  continuesFrom?: string;       // chatId this sitting continues
}
export interface SessionGoal {
  id: string;                   // slug
  text: string;                 // "Prove …" / "Compute …" / "State and use …"
  nodeIds: string[];            // plan nodes that serve it (filled by plan_init)
  status: "open" | "met" | "partial" | "unmet";
}
```

Breaks are not stored as state. They are messages of `customType: "break"` (start/end), so the clock can be replayed from the record, the same way FSRS state is replayed from the log in retention mode.

**Evidence records get `minutesIn`**, the active minutes into the sitting when the record was written. This makes the fatigue analysis direct instead of reconstructed.

## 3. The clock

A pure module, `src/core/session-clock.ts`:

```ts
activeMinutes(messages, { gapMin: 20 }) // sum of gaps < gapMin, minus explicit breaks
clockState(record, now) → { usedMin, budgetMin, leftMin, phase }
// phase: "probe" | "teach" | "converge" (≥ 85 %) | "close" (≥ 100 % or begin_close) | "closed"
```

It uses the same rule as `tools/lh-analysis/analyze.py`'s `active_hours`, so the app and the analysis agree on what a minute is. It has unit tests over fixtures with gaps, breaks and extensions.

## 4. How the tutor learns the time

The tutor only paces if it is told the time. It should be told without a model call of its own and without extra context per turn. There are two channels:

1. **On every graded answer** (the result of `quiz` / `explain` / `recall` / `probe`, built next to `compactAnswerForModel`), add `clock: { used: 38, left: 22, phase: "teach" }`. This works on every engine, Claude Code included, because answer results always reach the model.
2. **On phase changes only**, a one-line `contextUpdates` entry such as "Converge: 9 min left before the close; no new nodes", using the same seam that side questions use (`chat-handler.ts`). *Verify that it reaches the Claude Code engine; if not, channel 1 alone is enough.*

**Doctrine.** A new segment, `shared/45-timebox.md`, composed only when the session has a timebox. Composition needs a small conditional in `prompt-segments.ts`, analogous to profiles. It covers:
- **Probe**: at most ~15 % of the budget. End with `set_goals`, 1–3 goals sized by the rate in §5.
- **Teach**: work toward the goals. A missing prerequisite goes on a backlog in the hand-off, and the goal only moves when the learner agrees.
- **Converge** (≥ 85 %): finish the current node. No new nodes; one last check per open goal if there is time.
- **Close**: call `begin_close`, ask one blank-page retrieval per goal, call `close_session` with the verdicts and the hand-off. Don't skip the close when time is short; shorten teaching instead.
- **Fatigue**: if the last 4 graded answers show 2+ hints or idk, or answers are clearly shrinking, *offer* a 5-minute break or an early close. The tutor never forces it.

**New tools** (teacher, in a timeboxed session):

| Tool | Does |
|---|---|
| `set_goals({goals})` | Writes `timebox.goals`. It can be called again only with the learner's agreement, and the result says when goals were changed. |
| `begin_close()` | Sets `closingStartedAt`; the phase becomes `close`. |
| `close_session({verdicts, handoff})` | Checks that every goal has a verdict and that each "met" has at least one credited evidence record on its nodes in this session, then sets `closedAt`. A "met" with no evidence is refused. |

## 5. Sizing the plan to the budget

From the data, math mode closes about **3.3 evidence nodes per hour**, standard mode about 8.

| Budget | Probe | Teach | Close | Goals | New nodes (math mode) |
|---|---|---|---|---|---|
| 25 min | 4 | 16 | 5 | 1 | 1 |
| 45 min | 6 | 33 | 6 | 1–2 | 2 |
| 60 min | 8 | 45 | 7 | 2 | 2–3 |
| 90 min | 10 | 60 + 10 break | 8 | 2–3 | 3–4 |

`plan_init` already returns `scopeWarnings` in math mode. In a timeboxed session the node soft limit becomes `ceil(teachMin / 60 × rate) + nodes already solid` instead of the fixed 15. "Already solid" means probe-credited or `assumed` from an earlier session. The map can still hold prerequisites that are already known; only the new nodes are counted.

The 90-minute budget includes a suggested **10-minute break at about 50 minutes**. The clock pauses for it and the session continues afterwards. That is still one sitting, which is the point.

## 6. UI

| Where | What |
|---|---|
| `components/new-session.tsx` | **Time** pill (25/45/60/90 or off), remembered like the Math mode pill |
| top bar (`components/chat.tsx`) | clock `used / budget`, **Break**, **Extend +15** (once), **Close now** (asks the tutor to begin the close) |
| plan window | goals with status above the map |
| closed session | read-only composer; **Continue in a new session**; hand-off shown as the last card |
| sidebar (optional, phase 3) | today's total: `1 h 50 of 4 h`, counting only time-boxed active minutes. The daily target is a setting, default off |

## 7. Review and practice

- **Review sessions** already finish in about 11 minutes. A budget there sets the item count instead of the fixed "about six": `pick_items` takes `floor(budget / 3)` items, and there is no close ritual. A small change for phase 2.
- **Practice** is untouched in this plan.

## 8. Phases

| Phase | Scope | Size |
|---|---|---|
| **0: clock** | `SessionTimebox` (budget only), the Time pill, `session-clock.ts` + tests, `clock` on answer results, `minutesIn` on evidence, the timebox doctrine (pacing and converge only) | S–M |
| **1: goals and close** | `set_goals`, `begin_close`, `close_session`, goal display, closed state, **Continue in a new session** with hand-off seeding, recap retrieval on a stale reopen | M |
| **2: sizing and breaks** | budget-aware `plan_init` limit, Break/Extend, the 90-min mid-break, fatigue offer, review item count from budget | S–M |
| **3: analysis and daily view** | `lh-analysis`: budget vs actual, goal-met rate, accuracy by `minutesIn`, closed vs abandoned sessions; optional daily total in the sidebar | S |

Phase 0 is useful on its own: the tutor starts pacing, and the analysis gets exact minutes.

## 9. How to tell whether it worked

Rerun `tools/lh-analysis` after about two weeks of time-boxed sessions and compare:
- **goal-met rate** per session (baseline: 0 of 9 math-mode sessions reached the plan goal);
- **abandoned/resumed sessions** (baseline: most);
- **accuracy by `minutesIn`**: does the curve flatten when sittings stay under an hour?
- **first-review pass rate of items from closed sessions versus unclosed ones** (baseline 46 %). This is the real test, because the close is meant to improve retention, not just tidiness.

## 10. Open decisions

1. **Default budget.** The data points to 60 min as the ceiling; 45 may be better for new, hard material. Proposed: 60, with the pill remembered.
2. **Soft or hard end.** Proposed: soft. The tutor closes at the next boundary, with one +15 extension, and the session is never cut off mid-answer.
3. **Standard mode too, or math mode only?** Proposed: both. The rate in §5 differs per mode.
4. **Who writes the goals?** Proposed: the tutor proposes them after the probe and the learner edits. Goals typed at session start are passed to the prober as the target.
5. **Should a closed session be reopenable** (e.g. to ask one question)? Proposed: side questions only; new teaching goes in a continuation.
