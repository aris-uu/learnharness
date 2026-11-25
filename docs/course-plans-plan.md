# Courses: one map, many sittings

**Status:** phases 0–3 built, 2026-11-23 (uncommitted on the fork). See §14 for what was built and where it differs from this plan.
**Builds on:** [timeboxed-sessions-plan.md](timeboxed-sessions-plan.md) (one chat is one sitting). This keeps that rule and adds the layer above it.
**Motivation:** `D:/projects/learning/reports/timeboxed-sessions-2026-11-22.md` and the first time-boxed continuations.

## The problem

Time-boxing fixed the sitting: a budget, a few goals, a close. But **the big picture now lives nowhere.** When the learner brings a whole syllabus or a whole problem set, only one sitting's worth of it survives the close.

| Where it is lost | Code | Effect |
|---|---|---|
| The map is cut to the sitting | `budgetPlanWarnings` in `src/agent/tools/plan.ts` ("a 60-minute sitting fits about 3 … put the rest on the hand-off's later list") | The tutor builds a small map. Everything else survives only as a line in the hand-off. |
| Continue carries only the hand-off | `ClosedSittingCard` in `components/math-mode.tsx` (prompt = title + hand-off + unmet goals) | The next sitting has no syllabus, no problem-set images and no map. The learner re-pasted the PDE sheets by hand. |
| The hand-off is the wrong kind of document | `close_session.handoff` ("what the next sitting should start with … deferred later items") | It describes what comes next, not the whole thing. It is also written by a tutor who assumes the reader knows what it knows. |
| Memory items are per chat | `src/core/memory/review.ts` keys items `${chatId}#${nodeId}` | The same node taught across two sittings becomes two unrelated memory items. |

Two scopes have been conflated. **The map belongs to the topic and lasts.** **Goals belong to a sitting.** The time budget should constrain the goals, never the map.

## 1. Concepts

| Term | Meaning |
|---|---|
| **Course** | A topic pursued over several sittings: its sources, one map, and the list of its sittings. |
| **Sources** | What the learner brought: the first message's text, its attachments (pasted images, PDFs), and a **digest**, a text transcription the tutor writes once (§4). |
| **Map** | The course's full plan tree, comprehensive from the start. It is edited over time, never shrunk to fit a sitting. |
| **Sitting** | One time-boxed chat, exactly as today. It belongs to one course. |
| **Slice** | The map nodes a sitting's goals cover. The budget limits the slice. |

## 2. What the learner sees

**Starting.** Unchanged: a new teach session with a Time pill. Every time-boxed teach session **implicitly** starts a course of one sitting. The learner never has to "create a course"; it only becomes visible once there is a second sitting.

**Planning.** After the probe the tutor builds the **whole** map: for the PDE sheets, all twelve nodes (characteristics, boundary data, d'Alembert, separation of variables, the steady-state shift, finite differences, upwind/CFL, von Neumann). Then it proposes this sitting's goals as a slice of it. The map window shows three states: **done**, **this sitting**, **later**.

**Continuing.** "Continue in a new session" starts the next sitting of the **same course**. The tutor already has the sources, the full map with statuses, and the sitting history, so nothing needs to be re-pasted. It opens with a short recap retrieval (§5) instead of a placement probe, then proposes the next slice.

**Seeing the whole.** The map window shows progress across sittings, for example `7 / 12 nodes`. A node that was solid but has gone stale in the memory model shows as **stale** and is offered back into a slice.

## 3. Data model

A new store next to `chats/`, `graph/` and `jobs/`:

```ts
// src/core/contracts/course.ts
export interface CourseRecord {
  format: 1;
  id: string;                 // crs_…, its own id (see "Identity" below)
  title: string;
  createdAt: string;
  sources: CourseSource[];
  digest?: string;            // tutor-written transcription of the sources (§4), markdown
  map: PlanTree;              // the current full map
  mapHistory: Array<{ at: string; chatId: string; tree: PlanTree }>; // previous versions
  sittings: CourseSitting[];
  aliases: Record<string, string>; // old item key `${chatId}#${nodeId}` → course node id
}
export interface CourseSource {
  chatId: string;
  messageId: string;          // the learner message that brought it
  text: string;
  attachments: string[];      // paths under the data dir, e.g. pasted-images/…
}
export interface CourseSitting {
  chatId: string;
  startedAt: string;
  closedAt?: string;
  budgetMin?: number;
  goals: SessionGoal[];       // with verdicts after the close
  handoff?: string;
  handoffSource?: "close" | "reconstructed"; // reconstructed = written at adoption (§9)
}
```

The chat gets `settings.courseId`. `TimeboxState.continuesFrom` stays, for the order of sittings.

**Identity.** A course has **its own id** (`crs_…`), not a chat id. A chat id would only work for a course of one: once two existing chats are grouped (§9), their items carry two different chat ids. Instead:
- new memory items in a course are keyed `${courseId}#${nodeId}`. A node taught in sitting 3 credits the **same** item as in sitting 1;
- items that already exist keep their `${chatId}#${nodeId}` key. The course's `aliases` table maps each one to a course node. Memory, review and evidence lookups resolve keys through it, so **nothing already stored is rewritten**. The evidence log stays append-only;
- evidence keeps `chatId` (where it was recorded) and gains `courseId` (what it counts toward). For records written before the course existed, `courseId` is resolved through the aliases on read;
- a chat with no `settings.courseId` behaves exactly as today.

Node ids are **stable within a course.** The map can gain, retitle or retire nodes, but it never reuses an id for a different idea, because ids are memory keys.

## 4. Tools

| Tool | Change |
|---|---|
| `plan_init` | In a course, writes `course.map` (the old map goes to `mapHistory`). **The budget warning is removed here.** A size warning remains (say above ~40 nodes: "split into two courses?"). In a continuation, existing node ids must be kept. |
| `set_goals` | Goals' `nodeIds` must be in the course map. **The budget warning moves here:** "these goals cover 6 new nodes; a 60-minute sitting fits about 3". Nodes already solid in the course don't count. |
| `record_digest({digest})` (new) | The tutor writes the digest once, after reading the attachments in the first sitting: the syllabus outline, or every problem with its number and statement, plus what the learner said about the context ("exam soon"). It can be updated with the learner's agreement. Cap about 4k tokens. |
| `close_session` | The hand-off gets narrower and more useful: **what changed this sitting** (what holds, what's fragile, named habits) and **a few of the learner's own words** per fragile item (for example "i substituted for C twice while not knowing what it is"). It no longer needs a "later" list, because the map holds that. The tool writes the sitting into `course.sittings`. |

The digest is the key to dropping the attachments. A problem set read once as images becomes text that every later sitting gets cheaply. The original images stay available through `read` when the tutor needs a figure.

## 5. Seeding a sitting

The seed is built **server-side** as a context segment, not as a prefilled user message (today's `stashContinueDraft`). Then it can't be edited away by accident and can be regenerated.

```
Course: transport pde · sitting 2 · 60 min
Sources: (digest) Sheet 1: 1(a) u_t + xu_x = 0 …  Sheet 2: … 4) c=3, φ=x/(1+x²), ψ=4x+2 …
Map (12 nodes):
  ✓ chain-rule · ✓ char-const · ✓ char-inhom · ✓ char-var
  · char-boundary · wave-factor · dalembert · sep-var · steady-shift
  ✓ fd-basics · · upwind-cfl (probe: wrong direction) · vn-stability
Sittings: 1) 2026-11-22, 51/60 min, characteristics met, d'Alembert unmet
Last hand-off: fragile: x vs x(t) on the right-hand side; trace-back inversion guessed …
```

Size: digest ≤ 4k tokens + about one line per node + one line per sitting + the last hand-off. For a typical course that is 3–6k tokens, a fraction of one sitting's transcript.

**Probe becomes recap.** A continuation sitting doesn't re-place the learner. It runs a recap retrieval of at most ~3 minutes on (a) the last hand-off's fragile items, and (b) solid nodes in the proposed slice that the memory model marks stale. Then it proposes goals. The timebox doctrine (`shared/45-timebox.md`) gets a continuation clause for this.

## 6. Choosing the next slice

The tutor proposes, the learner picks. Candidate order:
1. unmet and partial goals from the last sitting;
2. frontier nodes, whose prerequisites are all solid;
3. weighting from the digest, when the sources say so (exam problems, "the exam covers …");
4. stale nodes to refresh.

The learner can always name a different slice ("do the FD side today").

## 7. UI

| Where | What |
|---|---|
| plan window | full course map; nodes coloured done / this sitting / later / stale; `7 / 12` progress |
| closed sitting card | **Continue course**, which starts the next sitting with the server-side seed |
| sidebar | sittings of a course grouped under its title, newest first |
| course view (phase 2) | sources, digest (editable), map, sitting list with verdicts and hand-offs |

## 8. Review and consolidation

Memory items are keyed by course id or resolved to a course node through its aliases (§3), so review and consolidation sessions see one item per node per course. Consolidation can pick across a whole course, for example "everything solid in the PDE course" before the exam.

## 9. Adopting existing sessions

Most of the history predates time-boxing and courses: bilinear forms, spherical geometry, point-set topology, both principal-bundles chats. These have no goals, verdicts or hand-off. Two operations bring them in. Both **only add** a course record and aliases. They never edit the adopted chats, their evidence or their memory items.

### 9.1 One unfinished session → a course

From a chat's menu: **Make a course from this session.**

1. **Sources:** the chat's first learner message (text and attachment paths). The tutor writes the digest from it as in §4.
2. **Map:** the chat's latest `tree`, node ids kept. Every node gets an alias `${chatId}#${nodeId}` → the same id.
3. **Sitting 1:** the chat itself, with `closedAt` unset and goals empty. The chat gets `settings.courseId`.
4. **Hand-off:** the tutor reads the transcript and writes one, marked `handoffSource: "reconstructed"`. It covers what holds per the evidence, the habits that recur, and where the chat stopped. For bilinear forms that would be mid-question; the record shows exactly where.
5. **Statuses:** from the chat's evidence, passed through the memory model, so a node that was solid two weeks ago shows as **stale**, not done.

The old chat stays as it is and stays readable. New teaching goes in a new sitting, seeded per §5. The first one opens with the recap probe, and that matters more here because the gap is usually days.

### 9.2 Several sessions → one course

From the sidebar: select chats → **Group into a course.** For example spherical + hyperbolic geometry (both from the MA3042 syllabus), the two principal-bundles chats, or point-set topology with its practice session.

1. **Sources:** every chat's first message becomes a source. The digest is written over all of them, so when the same syllabus was pasted twice, it appears once.
2. **Node matching.** Each old chat made up its own slugs, so the same idea has different ids in different chats. The tutor proposes a mapping by comparing node titles, plan statements and the propositions the knowledge graph extracted from each chat. The **learner confirms it** in a review table:

   | Course node | From chat A | From chat B | Proposed because |
   |---|---|---|---|
   | `conj-moves-lines` | `iso-move-lines` (spherical) | — | only one |
   | `three-reflections` | `three-refl-2-7` (spherical) | `three-inversions` (hyperbolic)? | **analogous, not identical: keep separate** |

   Every row is *merge*, *keep separate*, or *drop from the map*. Merging decides which memory items count as one node, so it is never automatic. When unsure, the default is keep separate.
3. **Map:** the union of the confirmed nodes, with edges carried over from each chat's tree. The tutor may propose the missing edges between the parts (for example spherical reflections → hyperbolic inversions) for the learner to accept.
4. **Sittings:** the chats in date order. A practice or review chat becomes a sitting of kind practice/review; it adds evidence but no goals.
5. **Memory items for merged nodes.** Two old items now resolve to one node. Their review histories are **read together** as one history in time order. Nothing is rewritten: the alias table can be removed and the old items come back unchanged.

**Ungrouping:** removing a chat from a course deletes its aliases and its sitting entry. Its evidence and items are untouched, so the result is exactly the state before grouping.

### 9.3 Rules for both

- **A chat belongs to at most one course.** Grouping a chat that is already in a course moves it, after asking.
- **Adoption is never silent.** It is always a learner action from the menu or sidebar. The tutor may *suggest* it ("this looks like the MA3042 course from 2026-11-17"), but it doesn't group on its own.
- **Old "solid" is not current.** Adopted statuses always go through the memory model, and the recap probe checks anything stale before the slice relies on it.

## 10. In-chat sitting divider (deferred)

An alternative to a chat per sitting: a "Sitting 2" divider in the same chat that resets the clock and goals. With the course seed in place, a new chat is cheap and doesn't grow the context, so a divider isn't needed. If it is added later, it should roll over to a new chat once the transcript passes about 150k tokens, rather than leaving it to a random compaction.

## 11. Phases

| Phase | Scope | Size |
|---|---|---|
| **0: quick fix** | The Continue draft also carries the first learner message (text plus attachment paths) and the previous map with statuses. The budget warning moves from `plan_init` to `set_goals`. | S |
| **1: course record** | `CourseRecord` store and contract (with `aliases`, even if only identity aliases at first), `settings.courseId`, implicit creation, `record_digest`, course-aware `plan_init`/`set_goals`/`close_session`, the server-side seed, the recap probe, `courseId` on evidence | M |
| **2: UI** | Map states and progress, Continue course, grouped sidebar, course view | M |
| **2b: adoption** | §9: make a course from one session, group sessions with the node-matching table, alias resolution in memory/review/evidence lookups, ungroup | M |
| **3: analysis** | `tools/lh-analysis` per course: sittings, minutes, nodes reached, recap minutes, goal-met rate | S |

Phase 0 alone ends the re-pasting.

## 12. How to tell whether it worked

- **Re-pasted sources:** zero (today: the PDE sheets on the first continuation).
- **Minutes before teaching in continuation sittings:** recap ≤ 3 min. For reference, the first-sitting probes took 12 min (hyperbolic, 25-min budget) and 8 min (transport, 60 min).
- **Map coverage:** the share of a course's map reaching solid over its sittings, and how many sittings it takes.
- **No duplicate memory items** for one node within a course.
- **Hand-off quality:** a continuation's recap questions hit the actual fragile items (check by reading).

## 13. Open decisions

1. **Implicit or explicit courses?** Proposed: implicit (every time-boxed teach session is a course of one). An explicit "New course" is only needed for a syllabus spread over many sources.
2. **Who writes the digest?** Proposed: the tutor, once, with the learner able to edit it in the course view. Alternative: store attachments only and re-read them each sitting (more tokens, no transcription errors).
3. **Map size limit.** Proposed: a warning above ~40 nodes suggesting two courses. Point-set topology grew to 35 nodes over 4 re-plans.
4. **Who may restructure the map?** Proposed: the tutor may add prerequisites freely. Retiring or regrouping nodes needs the learner's agreement, since ids are memory keys.
5. **Nodes shared between courses** (the chain rule appears in PDE and multivariable calculus)? Proposed: out of scope here. The knowledge graph links propositions across sessions, and courses don't need to.
6. **Untimed sessions.** Proposed: new courses start implicitly only from time-boxed teach sessions. Untimed chats join a course only through adoption (§9), and their new sittings are time-boxed.
7. **Merged review histories.** When two old items merge into one node (§9.2), is reading their histories together right for FSRS, or should the course node start from the more recent item only? Proposed: together, in time order, since both were real reviews of the same idea. Check this against the retention-mode replay.
8. **Graph propositions for matching.** Is the knowledge graph's extraction complete enough to help match nodes, or only node titles? Proposed: use it when present and fall back to titles. The learner confirms every row either way.

## 14. Implementation notes (2026-11-23)

What exists, by phase:

- **0–1.** `src/core/course.ts` (types, item keys, seed, doctrine, matching, reconstructed hand-off), `src/core/course-ops.ts` (operations over ports), `src/store/courses.ts` (`data/courses/<id>.json`), `settings.courseId`. A course is created implicitly at the first `plan_init` of a time-boxed teach session, or when a chat continues another. `plan_init` refuses a course map that drops evidenced nodes; `set_goals` carries the budget warning; `set_goals`/`close_session` sync the sitting; `record_digest` is a prober/teacher tool inside a course. The seed and the course doctrine are appended to the prober and teacher prompts in `chat-handler.ts`, excluding the running sitting's own evidence so the prompt stays stable within a sitting.
- **2.** Plan popup: a "This sitting / Course · d/t done" switch, with corner marks (✓ done, ~ stale, … started) and this sitting's goal nodes highlighted. Closed-sitting card: "Start the next sitting" with a one-line prompt (the seed carries the rest, including the last sitting's unmet goals). Course pages at `/course` and `/course/<id>` (title, map by state, editable digest, sources, sittings with hand-offs, remove, start next sitting). API: `GET/POST /api/courses`, `GET/PATCH/DELETE /api/courses/<id>`, `GET /api/chats/<id>/course`; `POST /api/chats` accepts `courseId`.
- **2b.** Session menu: "Make a course from this session" (or "Open course"). Grouping on the course pages: pick sessions → proposed matching table (editable id, title, merge/separate/drop) → confirm. Sessions already in another course move.
- **3.** `tools/lh-analysis/analyze.py` has a Courses table.

Where it differs from the plan:

- **No `courseId` on evidence records.** Evidence and reviews are never rewritten; `configureItemKeys(() => courseItemKeys(courseStore.list()))` at the composition root resolves `chatId#nodeId` to `courseId#node` through sittings and aliases, everywhere memory items are built.
- **Matching is deterministic** (title token similarity ≥ 0.6, a bonus for equal slugs), not graph-proposition based (§13.8). The learner confirms every row.
- **Reconstructed hand-offs are deterministic** (states and habits from evidence, the last node, the last tutor message, any pending question), not model-written. They are marked "reconstructed" in the seed and the course page.
- **Sidebar:** rows are not regrouped under courses, since sessions already live in folders; the meta line names the course instead, and a Courses entry sits next to Memory.
- When the existing course map is part of a grouping, its own nodes keep their ids and a "drop" row on them is ignored (their evidence may matter). Remove nodes through the tutor's `plan_init` instead, which checks evidence.

Not yet verified in the running app; covered by `tests/course.test.ts` and typecheck.
