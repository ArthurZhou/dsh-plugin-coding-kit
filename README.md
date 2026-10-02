# dsh-plugin-coding-kit

A dsh agent preset with a tuned coding-agent system prompt, and a durable memory
system.

Two things, one bundle:

- **A better default prompt.** It replaces the harness's persona and identity
  line with text written for careful engineering work. Every tool, every tool
  guardrail, and plan mode stay exactly as the harness registered them. It also
  says *when* to reach for a goal, a task list and memory — all three were in the
  catalogue and went unused, because a tool description only says what a call
  looks like, not when making it is the expected move.
- **Memory that survives the session.** Three scopes, one tool, and the prompt
  text that teaches the model to use them — the harness has no equivalent, so
  both halves ship together and are tested together.

Installing the bundle installs the preset. Nothing else to run.

## What it actually replaces

Each model request draws on three independent channels. Only the first is "the
prompt":

| Channel | Carries | This plugin |
| --- | --- | --- |
| **Prompt sections** → joined by `renderPrompt()` into the system message | the identity opener, the deployment persona, `plan:policy`, and one guardrail per tool (`tool:read`, `tool:bash`, …) | **rewrites two**, leaves the rest |
| **Tool schemas** → sent as native function-calling tools | every tool's name, description, and JSON schema | untouched |
| **Runtime context** → prepended as a *user* message, not a system section | cwd, clock, terminal state | untouched |

So the agent keeps the full `standard` toolset — shell, filesystem, edit,
search, jobs, goals, skills, plan mode, compaction, subagents, workflows — and
the system message changes from

```
You are an AI agent powered by DeepSeek Harness.
You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.
[tool:read]  Use the read tool — not shell commands like cat — to inspect text files.
```

to

```
You are a coding agent working in this user's codebase, running on the {{model}} model. Your working directory is {{cwd}}.
…
## Look before you change anything
…
[tool:read]  Use the read tool — not shell commands like cat — to inspect text files.
```

## How the swap works

The prompt registry resolves an agent's view as `agent → preset → global`,
nearest shadowing farthest, so a section registered from a preset's layer
replaces the same-named global one for agents on that preset and for nobody
else. This plugin registers two:

- **`deployment:persona`** — the persona, shadowing the deployment's own slot.
- **`harness:identity`** — registered with **empty text**. `renderPrompt()` drops
  any section whose interpolated text is empty, so the shadow removes the
  identity opener instead of printing a blank line. It is the agent-plane
  counterpart of the host-plane `includeHarnessIdentity: false` service config,
  which this plugin deliberately does not use — that one is global by
  construction and would change every preset.

### Why `complete: true` is *not* set

`dsh-persona` accepts a `complete` flag that makes the persona the **sole**
system section. It is the one-line way to "not inject the harness prompt", and it
is the wrong one here: it also drops `plan:policy` (order 50) and every `tool:*`
guardrail, silently disabling plan mode and losing the exit-code rule. The
preset keeps the persona non-complete, and a test asserts it stays that way.

## Writing the prompt

Three tools carry work past the end of one turn: the **task list** holds the
steps, the **goal** holds the objective, **memory** holds what should still be
there next session. All three ship in the catalogue with competent tool
descriptions, and all three went under-used. The first pass of this prompt fixed
memory and left the goal dead — the section explained the mechanism and spent its
only guard-rail on what *not* to create, so it argued the model out of the call
it was trying to get.

The three policies now share one shape:

- **A deadline, not a louder rule.** A description already says what a call looks
  like; saying it harder does not fix a deferral. What fixes it is naming the
  moment by which the call must have happened — the goal exists before the first
  tool call, the list before the first step, a decided note before the reply that
  mentions it. Borrowed from the one shipped prompt that solves this exact
  failure: Claude Code's memory instructions treat an offered next step as "a
  finished engagement, not permission to defer".
- **A concrete trigger**, in the requester's words rather than an adjective:
  "several subsystems or many files touched", "three or more steps", "an
  investigation before the change is even known".
- **A stated skip condition beside it** — big request → create it; single
  question or one file → skip it. A rule with no exit is ignored or over-fired,
  and both are ways of not using the tool. Deliberately *not* "if in doubt, use
  it" (a documented over-triggering recipe) and *not* MUST/CRITICAL wording
  (vendor guidance is to dial that back to "use this tool when…"). Graded
  MUST/SHOULD/MAY obligation is plausible and untested, so it is not used.
- **One example per policy, with the reason attached.** Few examples beat many —
  excessive few-shot degrades, per model — and the reason teaches the boundary
  rather than the action.
- **Mechanics left alone.** The tool descriptions and `tool:goal` already carry
  them; a second copy only drifts.

Position matters as much as wording: attention over a long prompt is U-shaped,
so the rules most likely to be forgotten sit in the first half rather than in a
closing "guidelines" section, which is where they reliably stop working.

Two other rules the text follows. The harness already ships `tool:read`,
`tool:write` and `tool:edit` with the mechanical rules this prompt used to repeat
verbatim, so those paragraphs were deleted and the characters spent on judgement
instead. And nothing is conditional on a mode: the harness runs one, so half a
prompt describing a state the agent is not in is worse than none.

The XML-style delimiters are for disambiguation, not adherence — a 600-call
comparison put XML and Markdown boundaries at 98.4% and 98.8%, i.e. a wash. They
are also deliberately *not* Copilot's names, so a diff against another vendor's
prompt stays meaningful.

## The cheap lane

The preset registers a second subagent tool, `subagent_cheap`, pinned to a much
cheaper model, and `<costPolicy>` in the persona decides what goes down it.

**Why a config row rather than a prompt.** The `subagent` tool has no per-call
model parameter — `agentOptions` is composition config applied to every child
that tool starts. A prompt cannot route work at a different model; only a second
registration can. So the split is: the **row** owns *which model*, the **prompt**
owns *when*, and the skill owns *how to call it*. That split is the point. A
model name written into a prompt is a name a model can misspell, and a misspell
is a failed tool call in the middle of a batch. Here it is a one-line edit in
`preset/agent.cordis.yml`, re-pointable at any `:free` id without touching the
prompt text or retesting it.

**What is in the row.** `agentOptions.provider` and `.model` are the provider
route name and a model id from that provider's list in `settings.yaml` — change
them together, since the adapter interprets the id. `maxTokens` caps the child.
`toolFilter.allow` keeps the child on `read`/`glob`/`grep`/`bash`: look and
compute, do not decide and do not write. The delegation driver pins a child's
approval policy to `never`, so an escalating command fails rather than prompts,
which is another reason to keep the lane non-escalating. The `persona` string
registers as `deployment:persona` in the child's scope only — a shorter system
prompt plus an explicit output contract is part of what makes a weaker model
usable here, not decoration.

**Cost of the row itself.** One more tool in the catalog is a few hundred tokens
of tool schema on every request. It pays for itself the first time a batch of
mechanical work stops running on the session's model.

**Repointing it.** Change `agentOptions.model` to any id under
`llm-pi-ai.providers.<provider>.models` in `settings.yaml`; the `:free`
OpenRouter ids cost nothing at all. If your cheap lane should be allowed to edit,
add `edit`/`write` to the filter — and only together with a rule that its output
is reviewed before it lands.

## The lane console

Re-pointing the lane by hand means two files outside this repo and a check
nobody performs: whether the model id still exists upstream. The console is a
**section inside the harness's own settings page** — no second server, no port
of its own, and it works on any origin the app itself can reach.

### Why a projection instead of a direct write

`agent.cordis.yml` is the only editor of an agent composition: the preset roster
documents that files are the only composition editor, and it is right, because
the composition decides which tools exist and therefore has to be
reconstructable from a file. But a browser cannot write a file. The stock wire
exposes `settings` (settings documents), and a custom Typert domain would need
generated codecs. So the **intent lives in a `cheap-lane` settings namespace**,
which the wire already knows how to read, render and write, and the host row
pushes the resolved value into every composition carrying a
`tool-subagent-cheap` row:

```
settings.yaml `cheap-lane`   ← the browser writes this (stock settings API)
        │  host row: lib/host.mjs, on boot and after every commit
        ▼
~/.dsh/.agent-presets/*/agent.cordis.yml   ← the lane row, line-edited
```

The direction is one-way by construction. The namespace is the intent, the
composition is the projection, and the only read that goes the other way is a
one-time seed that runs while the user section is still empty — so a fresh boot
shows what the files actually say, and never overwrites a choice made in the UI.

### The three halves

| File | Job |
| --- | --- |
| `lib/host.mjs` | host row: registers the namespace, seeds it, projects it |
| `lib/client.js` | browser half: a `settings.section` slot, React without JSX |
| `lib/lane-projection.mjs` | the projection itself — pure logic, no cordis |

`lib/client.js` is hand-written rather than a build artifact. Every other client
package here is a tsdown bundle; a repository with no toolchain cannot produce one
honestly, and a checked-in bundle nobody can rebuild is a liability. So the same
`window.__ModuleLoader__.load(...)` registration is written out, using
`React.createElement` where a bundle would use JSX.

### Four contracts the editor holds, each of which cost a real bug

- **Comments survive.** The composition is edited line by line, never parsed —
  it carries `!!js process.platform` expressions a parser would mangle and prose
  that explains every row. The first version of this console round-tripped the
  files through the YAML parser and deleted
  `api: openai-completions # OpenRouter 兼容 OpenAI API[reference:14]` on a
  "no-op" write.
- **A write cannot reach a sibling block.** Insertion derives the block's first
  real child, not its header index: writing at the header put an `apiKey` into
  whichever provider *preceded* the one being edited — a bug that reads as
  success.
- **An unknown key is an error, not a no-op.** Including `toolName`, which the
  page deliberately does not offer: the persona and the skill both name
  `subagent_cheap` in prose, so renaming it from a settings page would leave the
  prompt routing to a tool that does not exist.
- **Every write is backed up, atomic, and verified twice** — once on the text
  before it is allowed to land, once on the bytes read back after. A projection
  that already matches writes nothing at all, so a config surface cannot start
  making changes nobody asked for.

### Pointing the lane somewhere else

Edit the section in the harness settings page, or write the namespace yourself:

```yaml
cheap-lane:
  modelProvider: openrouter
  model: google/gemma-4-31b-it:free
  maxTokens: 32768
  allow: [read, glob, grep]        # write/edit: only with a review rule to match
```

The deployment's base values live in `cordis.patch.yml` (`lane:`), so an install
ships a working route and settings.yaml layers a choice over it. A change reaches
**new sessions**: a session that already started keeps the tool set it was
composed with.

## Memory

DSH has skills (instructions the agent *loads*) and a session log, but nothing
that lets an agent **write down** what it learned and find it again next
session. The `<memoryProtocol>` block in `lib/persona.js` is not
aspirational — `lib/memory.js` implements the tool and the scopes it names.

### The three scopes

| Virtual path | Real location | Lifetime |
| --- | --- | --- |
| `/memories/` | `$DSH_HOME/memories/` | across workspaces and sessions |
| `/memories/session/` | `$DSH_HOME/memories/session/<sessionId>/` | one session |
| `/memories/repo/` | `<workspace>/.dsh/memories/` | this workspace |

`/memories/…` is a virtual path space over three real roots, so the model never
addresses a real path. Two decisions go against the obvious implementation:

- **Session memory is keyed by session id.** Clearing it when a turn ends would
  lose exactly the notes a resumed session needs, and a shared directory would
  let two concurrent sessions clobber each other.
- **The auto-load budget is 200 lines** across the user scope's top-level `.md`
  files, in filename order. Session and repo memory are *indexed, never
  auto-loaded* — the model's cue for what is safe to assume and what it has to
  go and read.

### The delimiters are ours

`<memoryInstructions>`, `<memoryScopes>` and `<memoryGuidelines>` are VS Code
Copilot's own tags — verbatim, visible in `copilot-prompt-capture/captures/`.
Reusing them would make this prompt a near-copy of another vendor's and any diff
against theirs meaningless, so the delimiters here are `<memoryProtocol>`,
`<memoryLayout>` and `<memoryWriting>`, and the index section is
`<memoryListing>`. Nothing parses them; they are cues for the model, so the
collision was the only thing worth avoiding.

### The tool

One `memory` tool with six commands: `view`, `create`, `str_replace`, `insert`,
`delete`, `rename`. `str_replace` requires a unique match and `rename` refuses
to cross scopes, both enforced rather than documented-and-hoped: the tool
description tells the model they hold, and a silent multi-match replace is how a
wrong hunk lands in a file the model believed it had edited deliberately.

### Trust boundary

**This is the one place the plugin writes outside the sandbox, and it is
deliberate.** Routing memory through `ctx.fs` would mean an approval prompt per
write, which defeats the feature in exactly the moment it is wanted — right after
a mistake, mid-task.

The exposure is bounded rather than absent. `lib/memory/paths.js` resolves every
path and proves containment against the three roots **on the real path after
symlink resolution**, so the tool can read and write text files in those
directories and do nothing else: it cannot read your files, cannot execute,
cannot write anywhere else. Reads get the same check as writes, because a
symlink is as good at exfiltrating through `view` as at overwriting through
`create`. The tests plant a symlink and a `..` traversal and assert both are
refused.

Set `memory: false` to register none of it — and delete the
`<memoryProtocol>` block from `text` at the same time, or the prompt will
describe a tool that is not in the catalog.

## Three contracts worth knowing

Each of these cost a real outage. They are pinned by tests that reproduce the
registry's exact behaviour, because none of them fails inside this plugin.

**A section's `text` must be synchronous.** `dsh-system-prompt` calls it with no
`await`, then `renderPrompt()` calls `.indexOf` on the result. An `async`
provider hands the renderer a Promise and every request dies with
`text.indexOf is not a function`. Hence `lib/memory/sync.js` and its
blocking-but-bounded reads.

**Injected memory is escaped.** `interpolate()` runs over *every* section and
reads any `{{name}}` as a prompt variable — substituting `provider`/`model`/
`cwd`, throwing on anything else. Memory files are written by the agent and by
you, so a note containing a template literal, JSX, or a Go format string would
fail every request; worse, a `{{model}}` in a note would be silently
substituted, so the prompt would claim the file says something it does not. So
every `{{` in injected content gets a zero-width space between the braces. Only
the injected copy is affected — the file on disk is untouched and the tool still
serves exact bytes.

**`output.render` returns content blocks, not text.** `dsh-tools` assigns its
return value straight to `result.content`, and every provider adapter walks that
array — `contentHasImage` is literally `content.some(...)`. A tool returning a
bare string registers and executes perfectly, then fails on the *next* request
while the adapter assembles it, as `content.some is not a function` with no
component attributed.

## Install

```sh
cd dsh-plugin-coding-kit && npm install          # the plugin's own dependency
dsh plugin --profile web add "$PWD"
```

That is the whole thing. The bundle's host-plane row installs the `coding-kit`
preset into `${DSH_HOME:-$HOME/.dsh}/.agent-presets/coding-kit/` on the next
boot, and preset discovery re-reads its roots on every call, so it appears in the
picker after a refresh.

The row is a composition row rather than a `postinstall` because a `link:`
install does not run the dependency's lifecycle scripts — a composition row is
the one hook that actually fires, in the profile that installed the bundle. It
copies two text files, mounts no service, **never overwrites an existing preset**
(so your edits to `agent.cordis.yml` survive every boot), and swallows its own
errors: a missing preset is one fewer option in a picker, never a failed boot.
Delete the directory to get the shipped copy back.

Then open a **new, blank** session and pick **编码助手模式**. A preset may only be
switched on an agent that has produced nothing — swapping tools mid-conversation
would leave logged tool calls the new composition cannot make.

The lane's skill is separate from the preset, because a preset row is not where
skills live. `skills/cheap-batch/SKILL.md` ships with the package and installs to
the user skill root:

```sh
mkdir -p "${DSH_HOME:-$HOME/.dsh}/skills/cheap-batch"
cp skills/cheap-batch/SKILL.md "${DSH_HOME:-$HOME/.dsh}/skills/cheap-batch/"
```

The user root is scanned for every workspace; the repo's own `.dsh/skills/` is
scanned only for this project, and a project entry outranks a user one of the
same name, so keep exactly one copy installed.

## Tuning

Override the row in `~/.dsh/.agent-presets/coding-kit/agent.cordis.yml`. A
`config` block **replaces** the row's whole value, so copy the text you want
rather than expecting a merge:

```yaml
- id: persona
  name: 'dsh-plugin-coding-kit'
  config:
    memory: true            # the tool and both prompt sections
    autoLoadLines: 200
    maxViewBytes: 50000
    maxWriteBytes: 200000
    maxListEntries: 200
    includeHarnessIdentity: false   # true keeps the opener, for A/B
```

Two rules the renderer enforces on anything in `text`, both covered by tests:
only `{{provider}}`, `{{model}}` and `{{cwd}}` are registered variables, and a
lone `{{` with a later `}}` is rejected as malformed.

## Test

```sh
npm test
```

`test/prompt-shadow.test.mjs` stubs both registries and pins the plugin's
contract. `test/shadowing.integration.test.mjs` uses the **real** `ScopedLayers`
and `renderPrompt` to prove the two upstream behaviours the design rests on: a
scoped section shadows a same-named global one, and an empty-text section is
dropped. `test/sections.test.mjs` drives the memory sections through the real
`renderPrompt`, because the synchronous-provider contract is invisible to a stub.
`test/memory.test.mjs` covers all six commands, all three scopes, and the
containment guarantees against a throwaway `$DSH_HOME`. `test/render.test.mjs`
applies the registry's own use of `output.render`. `test/interpolation.test.mjs`
covers the escaping, including a note that documents the bug it prevents.
`test/cheap-lane.test.mjs` pins the joins between the lane's three files —
composition, persona, skill — because that is the one part of the cheap lane
that no single file can verify and that no runtime reports when it breaks.
`test/lane-projection.test.mjs` does the same for the other seam: the line editor
and the projection from the settings namespace into the composition.

The unit suite ends with a check that the two duplicated slot names still match
the installed `@deepseek-ai/dsh-system-prompt`. That duplication is deliberate —
see `lib/constants.js` for why a `link:`-installed plugin cannot import a host
package — and the test is what makes it safe across a harness upgrade.

## Uninstall

```sh
dsh plugin --profile web remove dsh-plugin-coding-kit
rm -rf "${DSH_HOME:-$HOME/.dsh}/.agent-presets/coding-kit"
```

Neither affects the `standard` preset, which is untouched by design.
