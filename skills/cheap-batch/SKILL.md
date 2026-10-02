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

## Three gates — all three, or do it yourself

1. **Repetition.** The same simple operation, three or more times: many files,
   many rows, many lines, many fields. One-off work is not batch work.
2. **Mechanical check.** The right answer is verifiable without judgement — a
   `grep`, a compiler, a schema, a format check, a count you can re-run. If
   verifying it takes the same thinking as doing it, it is not cheap work.
3. **Loud failure.** A wrong answer surfaces. Quiet wrongness — a half-applied
   migration, a silently dropped permission, a deletion — disqualifies the lane
   even when steps 1 and 2 pass.

## Never take the lane when

- a trade-off, an intent, or a design is being decided — that is your job;
- the output would be applied to the repository unreviewed;
- the child needs context it cannot read for itself;
- you would have to reconcile its answer by re-reading everything it touched.

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

## Larger batches

Past roughly thirty items, or when the user explicitly asks for a fan-out, a
`workflow` script can take the same lane per agent: `agent(prompt, { model })`
overrides the model per call. Use it when the items are truly independent and
the concurrency cap is worth it; otherwise one batched `subagent_cheap` call is
simpler and cheaper.
