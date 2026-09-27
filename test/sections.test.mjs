import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { PERSONA_ORDER, PERSONA_SECTION } from '../lib/constants.js'
import { PERSONA } from '../lib/persona.js'
import { apply } from '../lib/memory.js'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'

/**
 * A regression test for the failure this suite once shipped with.
 *
 * `dsh-system-prompt` assembles a section like this:
 *
 *     text: typeof section.text === 'function' ? section.text(context) : section.text
 *
 * — no `await` — and then `renderPrompt()` runs `interpolate()`, whose first act
 * is `text.indexOf(...)`. An `async text(context)` provider therefore hands the
 * renderer a Promise and the whole turn dies with
 * `text.indexOf is not a function`.
 *
 * So the providers are driven here through the *real* `renderPrompt`, with a
 * section list assembled the way the registry assembles one. A promise comes
 * back out of `text()` and this fails, which is the point.
 */
let home
let workspace
let sections
let ctx

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-sec-home-'))
  workspace = await mkdtemp(join(tmpdir(), 'dsh-sec-ws-'))
  process.env.DSH_HOME = home
  sections = []
  ctx = {
    systemPrompt: {
      section(section) {
        sections.push(section)
        return { dispose: () => sections.splice(sections.indexOf(section), 1) }
      },
    },
    tools: { register: () => ({ dispose: () => {} }) },
    effect: (effect) => effect(),
  }
  apply(ctx, { memory: true, autoLoadLines: 200, maxViewBytes: 50_000, maxWriteBytes: 200_000, maxListEntries: 200 })
})

after(async () => {
  delete process.env.DSH_HOME
  await rm(home, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
})

/** What the registry hands a section's provider, and what it then does to it. */
const assembleContext = () => ({ agent: { session: { id: 'sec-session', header: { cwd: workspace } } } })

function renderLikeTheRegistry() {
  const assembled = sections.map((section) => ({
    name: section.name,
    // The line that caused the outage: no await.
    text: typeof section.text === 'function' ? section.text(assembleContext()) : section.text,
  }))
  return renderPrompt({ sections: assembled, variables: { model: 'test-model', cwd: workspace, provider: 'test' } })
}

test('every section provider returns a string, not a promise', () => {
  for (const section of sections) {
    if (typeof section.text !== 'function') continue
    const value = section.text(assembleContext())
    assert.ok(!(value instanceof Promise), `section "${section.name}" is async; the registry does not await it`)
    assert.equal(typeof value, 'string', `section "${section.name}" returned ${typeof value}`)
  }
})

test('renderPrompt over the real section set does not throw', () => {
  // The exact call that produced `text.indexOf is not a function`.
  const prompt = renderLikeTheRegistry()
  assert.equal(typeof prompt, 'string')
  assert.ok(!prompt.includes('[object Promise]'))
})

test('user memory is auto-loaded into the prompt when it exists', async () => {
  await mkdir(join(home, 'memories'), { recursive: true })
  const content = '# Notes\n- remember this line\n'
  await writeFile(join(home, 'memories', 'notes.md'), content, 'utf8')
  const prompt = renderLikeTheRegistry()
  assert.ok(prompt.includes('User memory, auto-loaded from /memories/'), 'the user memory section is missing')
  assert.ok(prompt.includes('remember this line'), 'the auto-loaded line is missing')
  // Line counts follow the same split the `view` command uses, so the
  // accounting is derived rather than hardcoded.
  const lineCount = content.split('\n').length
  assert.ok(prompt.includes(`(${lineCount}/${lineCount} lines of notes.md)`), 'the per-file accounting is missing')
})

test('an empty user scope contributes nothing rather than an empty heading', async () => {
  await rm(join(home, 'memories', 'notes.md'), { force: true })
  assert.equal(sections.find((section) => section.name === 'memory:user').text(assembleContext()), '')
  const prompt = renderLikeTheRegistry()
  assert.ok(!prompt.includes('User memory, auto-loaded'), 'an empty scope still rendered a heading')
})

test('the index section lists session and repo memory without loading it', async () => {
  await mkdir(join(home, 'memories', 'session', 'sec-session'), { recursive: true })
  await writeFile(join(home, 'memories', 'session', 'sec-session', 'plan.md'), '# Plan\nSECRET-BODY\n', 'utf8')
  const prompt = renderLikeTheRegistry()
  assert.ok(prompt.includes('/memories/session/sec-session/plan.md'), 'the session file is not listed')
  assert.ok(!prompt.includes('SECRET-BODY'), 'session memory was loaded instead of only listed')
})

test('a missing memory root degrades to the "none yet" index', async () => {
  await rm(join(home, 'memories'), { recursive: true, force: true })
  const prompt = renderLikeTheRegistry()
  assert.ok(prompt.includes('Session memory (/memories/session/): none yet'), 'a missing root broke the index')
})

test('the memory sections sit between the persona and the tool guardrails', () => {
  const names = [...sections].sort((a, b) => a.order - b.order).map((section) => section.name)
  const personaAt = names.indexOf(PERSONA_SECTION)
  const userAt = names.indexOf('memory:user')
  const indexAt = names.indexOf('memory:index')
  assert.ok(personaAt < userAt && userAt < indexAt, `unexpected order: ${names.join(' → ')}`)
  assert.equal(sections.find((section) => section.name === 'memory:user').order, PERSONA_ORDER + 1)
})

test('autoLoadLines: 0 disables auto-loading without breaking the section', () => {
  const disabled = []
  const bare = {
    systemPrompt: { section: (section) => { disabled.push(section); return { dispose: () => {} } } },
    tools: { register: () => ({ dispose: () => {} }) },
    effect: (effect) => effect(),
  }
  apply(bare, { memory: true, autoLoadLines: 0, maxViewBytes: 1, maxWriteBytes: 1, maxListEntries: 1 })
  assert.equal(disabled.find((section) => section.name === 'memory:user').text(assembleContext()), '')
  // The index is unaffected — listing is not loading.
  assert.ok(disabled.find((section) => section.name === 'memory:index').text(assembleContext()).includes('<memoryListing>'))
})

test('the persona is unchanged and still mentions the tool the sections teach', () => {
  assert.ok(PERSONA.includes('<memoryProtocol>'))
  assert.ok(PERSONA.includes('`/memories/`'), 'the scopes are not named in the instructions')
  assert.ok(PERSONA.includes('`memory` tool'), 'the tool is not named in the instructions')
})
