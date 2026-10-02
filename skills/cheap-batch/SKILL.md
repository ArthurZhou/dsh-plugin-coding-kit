---
name: cheap-batch
description: Run mechanical, repeatable, judgement-free work on the cheap model lane (subagent_cheap) instead of paying this session's model for it. Use when the same simple operation repeats across many files, rows, lines or fields, and the result can be checked mechanically.
whenToUse: The task is a batch of one identical, low-judgement operation — enumerate call sites, count or extract a field, reformat, fill a fully specified template — and a grep, compiler, schema or diff can tell whether the answer is right. Not when anything is being decided, and not for one or two items.
metadata:
  lane: subagent_cheap
  cost: cheap-model child agent; this session stays on its own model
---

# Cheap-batch lane

`subagent_cheap` is the same subagent tool as `subagent`, with a much cheaper
model pinned behind it in the preset. Your job is only to decide **whether** a
piece of work takes that lane, and to give it a prompt a stranger could execute.

The model id is configuration, not something you name. You never mention a
model, a provider or a price to the user.

## Four gates — all four, or do it yourself

1. **Repetition.** The same simple operation, three or more times: many files,
   many rows, many lines, many fields. One-off work is not batch work.
2. **Bounded scope.** The set of files or rows is stated in the prompt as a
   directory, a glob or a pasted block. A sweep whose boundaries you have not
   decided is not lane work — measured, an unbounded repository scan comes back
   short and presents the short answer as the whole answer.
3. **Mechanical check.** The right answer is verifiable without judgement — a
   `grep`, a compiler, a schema, a format check, a count you can re-run. If
   verifying it takes the same thinking as doing it, it is not cheap work.
4. **Loud failure.** A wrong answer surfaces. Quiet wrongness — a half-applied
   migration, a silently dropped permission, a deletion — disqualifies the lane
   even when steps 1 and 3 pass.

## Never take the lane when

- a trade-off, an intent, or a design is being decided — that is your job;
- the output would be applied to the repository unreviewed;
- the child needs context it cannot read for itself;
- you would have to reconcile its answer by re-reading everything it touched;
- the target is prose rather than code — Markdown, docs and files under dot
  directories (`.github/`, `.dsh/`) are this lane's measured blind spot: it
  returns code accurately and drops the documents, without saying so. Either
  scope the sweep to code, or run it yourself with `glob`.

Two failures of the same kind are the signal: a lane that keeps producing
unusable output means the task was never mechanical. Take it back.

## Shape the call

**One call per batch, not one call per item.** Every child pays its own system
prompt and tool catalog again. Ten single-item delegations cost more than doing
the work here; one ten-item prompt costs about one delegation. Two or fewer
items: skip the child entirely and do it yourself.

**The prompt is self-contained.** The child sees none of this conversation.
Include the exact operation, the exact scope (paths, globs, row ranges), the
exact output shape, and what to do when something is missing.

**Ask for an output you can check without reading it.** One record per line,
each with a locator (`file:line`, `row id`, `key`), and `UNKNOWN` rather than a
guess. A free-form prose report is a report you have to re-verify by hand, which
is the work you were trying to move.

**Background by default.** The lane runs in the background and returns a
subagent id. Start it, keep working on something independent, and read the
result when it settles. Pass `run_in_background: false` only when your very
next action depends on the answer.

## Verify before you believe

The child's output is evidence, not a conclusion. Run the mechanical check you
promised in the prompt — the grep, the compiler, the count — and reconcile any
mismatch yourself before it reaches the user or the repository.

Two checks are worth naming, because this lane's measured failures are silent:

- **Count check.** The child's count versus your own, from the same tool the
  prompt asked it to use. A cheap child that returns a plausible, short list and
  calls it complete is the ordinary failure here, not an exception.
- **Document check.** If the scope was supposed to include Markdown or files
  under dot directories, re-run those yourself with `glob`. The lane returns code
  reliably and under-reports prose, and it will not tell you it did.

## Record what you delegated

Before the reply that reports cheap-lane work you went on to use, write one note
with the `memory` tool. Repository scope, for this workspace:

```
lane: <provider/model> · <n> items over <scope>
checked: <the mechanical check you ran, and what it said>
got wrong: <anything the lane missed, and how you caught it>
```

One note per delegation, not per item — append to the workspace's lane note rather
than starting a fresh one per call, because a dozen single-call notes is a log and
a log is not what memory is for. Put a lesson in user memory instead when it holds
past this workspace: a lane that under-reports Markdown is worth remembering
everywhere, and the per-delegation count is not.

Skip it for a probe you threw away. What must never happen is the lane's output
quietly becoming part of the work with nothing left behind, because the next
session cannot weigh "the lane said 17" against anything.

## Larger batches

Past roughly thirty items, or when the user explicitly asks for a fan-out, a
`workflow` script can take the same lane per agent: `agent(prompt, { model })`
overrides the model per call. Use it when the items are truly independent and
the concurrency cap is worth it; otherwise one batched `subagent_cheap` call is
simpler and cheaper.
