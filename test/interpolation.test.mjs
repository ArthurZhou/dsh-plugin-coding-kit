import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { escapeInterpolation, memoryIndexText, userMemoryText } from '../lib/memory/sync.js'
import { resolveRoots } from '../lib/memory/paths.js'

/**
 * Prompt interpolation safety for injected memory.
 *
 * `dsh-system-prompt` runs `interpolate()` over every section's text and treats
 * any `{{name}}` as a prompt variable: registered names are substituted, unknown
 * ones throw. There is no per-region opt-out, and the whole section string is
 * scanned.
 *
 * Memory files are not authored by this plugin — the agent and the user write
 * them — so injected memory is untrusted text by construction. Anything with
 * braces in it has to be inert. The first version of this plugin injected memory
 * verbatim and failed with `unknown prompt variable "{{name}}"` on the first note
 * that mentioned template variables; these tests pin the fix.
 */
let home
let workspace
let roots

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-esc-home-'))
  workspace = await mkdtemp(join(tmpdir(), 'dsh-esc-ws-'))
  process.env.DSH_HOME = home
  roots = resolveRoots({ sessionId: 'esc', cwd: workspace })
  await mkdir(roots.user, { recursive: true })
})

after(async () => {
  delete process.env.DSH_HOME
  await rm(home, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
})

/** Render a section the way the registry does, through the real renderPrompt. */
function render(text) {
  return renderPrompt({ sections: [{ name: 'memory:user', text }], variables: { model: 'm', cwd: '/w', provider: 'p' } })
}

// ── the escaper ─────────────────────────────────────────────────────────────

test('escaping removes every {{ sequence', () => {
  const escaped = escapeInterpolation('{{name}} and {{model}} and {{ and {{}}')
  assert.ok(!escaped.includes('{{'), `still contains {{: ${escaped}`)
})

test('escaping leaves ordinary text untouched', () => {
  const plain = '# Notes\n- use the read tool, not cat\n- path: /home/az/x\n- {curly} braces are fine\n'
  assert.equal(escapeInterpolation(plain), plain)
})

test('escaping keeps the braces readable, only breaking the pair', () => {
  assert.ok(escapeInterpolation('{{name}}').replaceAll('\u200B', '').includes('{{name}}'))
})

// ── the hostile cases ───────────────────────────────────────────────────────

test('a registered variable in a memory file is not silently substituted', () => {
  // Without escaping, `{{model}}` in a note would render as the model name, so
  // the prompt would assert something the file does not say.
  const text = userMemoryText({ ...roots, user: writeFixture('reg.md', 'the persona line ends {{model}} here\n') }, 200)
  assert.ok(text.includes('{{model}}') || text.includes('{\u200B{model}}'), 'the literal was lost')
  assert.ok(!text.includes('the persona line ends m here'), 'a registered variable was substituted into memory content')
})

test('an unknown variable in a memory file does not break assembly', () => {
  const rootsWith = { ...roots, user: writeFixture('unknown.md', 'only {{provider}}, {{model}} and {{cwd}} are legal\n') }
  const text = userMemoryText(rootsWith, 200)
  // The exact call that threw `unknown prompt variable "{{name}}"`.
  assert.doesNotThrow(() => render(text))
  assert.equal(typeof render(text), 'string')
})

test('the note that triggered the original failure now renders', async () => {
  // Verbatim shape of the note that caused the outage.
  const note = [
    '# DSH harness',
    '',
    'The persona opens with:',
    '  `You are ... running on the {{model}} model.`',
    '',
    'Prompt variables are only {{provider}}, {{model}} and {{cwd}}.',
    'A bare `{{` in any section text is a malformed reference and throws.',
  ].join('\n')
  const text = userMemoryText({ ...roots, user: writeFixture('dsh-harness.md', note) }, 200)
  assert.doesNotThrow(() => render(text), 'the user note still breaks the prompt')
  assert.ok(render(text).includes('only'), 'the note body vanished')
})

test('hostile brace shapes are all inert', () => {
  const hostile = [
    '{{name}}', '{{}}', '{{ model }}', '{{{name}}}', '{{a}}{{b}}',
    '```js\nconst t = `${a}`\n```', '<div>{{x}}</div>', 'fmt.Sprintf("%v", {{y}})',
    '}} then {{', '{{ unclosed', '}}',
  ].join('\n')
  const text = userMemoryText({ ...roots, user: writeFixture('hostile.md', hostile) }, 200)
  assert.doesNotThrow(() => render(text), 'a hostile memory file broke assembly')
  assert.ok(!text.includes('{{'), 'a {{ survived into the section')
})

test('the index section is escaped too, since a path could contain braces', () => {
  const text = memoryIndexText({ ...roots, session: writeFixture('{{weird}}.md', 'x\n') }, 10)
  assert.doesNotThrow(() => render(text))
  assert.ok(!text.includes('{{weird}}'), 'a brace-bearing path reached the section unescaped')
})

test('the file on disk is never modified by escaping', async () => {
  const original = 'note with {{name}} in it\n'
  const fixture = writeFixture('untouched.md', original)
  userMemoryText({ ...roots, user: fixture }, 200)
  assert.equal(readFileSync(join(fixture, 'untouched.md'), 'utf8'), original)
})

test('the memory tool still serves the exact bytes', async () => {
  // Escaping is for the injected copy only; a model that reads the file to get
  // exact text for str_replace must not receive a zero-width space.
  const original = 'const t = `${a}` and {{name}}\n'
  writeFileSync(join(roots.user, 'exact.md'), original, 'utf8')
  const { defineMemoryTool } = await import('../lib/memory.js')
  const tool = defineMemoryTool({ maxViewBytes: 50_000, maxWriteBytes: 200_000, maxListEntries: 10 })
  const result = await tool.execute({ command: 'view', path: '/memories/exact.md' }, { agent: { session: { id: 'esc', header: { cwd: workspace } } } })
  assert.equal(result.text, original)
  assert.ok(!result.text.includes('\u200B'), 'the tool view leaked the escape character')
})

/** Write one file into the real user root and return that root. */
function writeFixture(name, content) {
  mkdirSync(roots.user, { recursive: true })
  writeFileSync(join(roots.user, name), content, 'utf8')
  return roots.user
}
