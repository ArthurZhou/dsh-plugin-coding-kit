import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { PERSONA } from '../lib/persona.js'
import { SOURCE_DIR } from '../lib/install-preset.js'

/**
 * The cheap lane's contract across its three halves.
 *
 * The design splits one behaviour over three files — the preset row owns *which
 * model*, the persona owns *when*, the skill owns *how to call it* — and a split
 * like that fails silently: rename the tool in one file and the prompt routes
 * to a tool that does not exist, with nothing in the product complaining. These
 * tests pin the joins, which is the only part that cannot be verified by
 * reading any single file.
 */

const composition = await readFile(join(SOURCE_DIR, 'agent.cordis.yml'), 'utf8')

/** The composition rows of one group, in file order. */
function groupRows(groupId) {
  const group = composition.slice(composition.indexOf(`- id: ${groupId}\n`))
  const rows = []
  let current = null
  for (const line of group.split('\n')) {
    if (/^ {4}- id: /.test(line)) {
      if (current !== null) rows.push(current)
      current = [line, []]
      continue
    }
    if (current !== null && /^ {4}\S/.test(line)) {
      rows.push(current)
      current = null
      continue
    }
    current?.[1].push(line)
  }
  if (current !== null) rows.push(current)
  return rows.map(([header, body]) => [header, body.join('\n')])
}

function rowText(rowId) {
  const row = groupRows('delegation').find(([header]) => header.trim() === `- id: ${rowId}`)
  assert.ok(row !== undefined, `delegation has no ${rowId} row`)
  return row.join('\n')
}

test('the lane is a second subagent row, not a prompt instruction', () => {
  const row = rowText('tool-subagent-cheap')
  assert.match(row, /toolName: subagent_cheap/, 'the tool is not registered under its own name')
  assert.match(row, /provider: spawn\b/, 'the lane stopped using the in-process spawn provider')
  assert.match(row, /backgroundMode: continuable/, 'the lane is not continuable like its sibling')
})

test('the lane pins a model instead of inheriting the session one', () => {
  const row = rowText('tool-subagent-cheap')
  assert.match(row, /agentOptions:/, 'no agentOptions: the lane silently runs on the parent model')
  assert.match(row, /provider: openrouter\b/, 'the agentOptions provider is not the one the model id belongs to')
  assert.match(row, /model: openai\/gpt-6-luna\b/, 'the lane is no longer pinned to the cheap model')
})

test('the lane looks and computes; it does not decide and does not write', () => {
  const row = rowText('tool-subagent-cheap')
  const filter = row.match(/allow: \[([^\]]*)\]/)?.[1]?.split(',').map((name) => name.trim()) ?? []
  assert.ok(filter.length > 0, 'the toolFilter allow list is gone, so the lane inherited every tool')
  for (const tool of ['read', 'glob', 'grep', 'bash']) {
    assert.ok(filter.includes(tool), `the lane can no longer ${tool}`)
  }
  for (const tool of ['write', 'edit']) {
    assert.ok(!filter.includes(tool), `the lane was given ${tool} without a review rule to match it`)
  }
})

test('the child persona survives interpolation', () => {
  const persona = rowText('tool-subagent-cheap').match(/persona: \|\n((?: {10}.*\n?)+)/)?.[1]
  assert.ok(persona !== undefined, 'the lane has no child persona')
  assert.ok(persona.trim().length > 0, 'the child persona is empty, so the deployment persona ships instead')
  // The driver registers it as a prompt section, and `interpolate()` throws on
  // any `{{name}}` that is not provider/model/cwd.
  assert.ok(!persona.includes('{{'), 'the child persona contains a template literal the renderer would expand')
})

test('the persona routes to the tool the composition registers', () => {
  assert.ok(PERSONA.includes('<costPolicy>'), 'the cost policy is gone from the persona')
  assert.ok(PERSONA.includes('subagent_cheap'), 'the persona names no lane, so nothing routes')
  assert.ok(!PERSONA.includes('{{costPolicy}}'), 'the policy is referenced as a prompt variable')
})

test('the skill teaches the call the tool actually accepts', async () => {
  const skill = await readFile(join(SOURCE_DIR, '..', 'skills', 'cheap-batch', 'SKILL.md'), 'utf8')
  assert.match(skill, /^---\n(?:.*\n)*?name: cheap-batch\n/, 'the skill frontmatter lost its name')
  assert.ok(skill.includes('subagent_cheap'), 'the skill does not name the tool it teaches')
  // The lane is continuable, so it returns an id and settles later; a skill
  // that teaches the one-shot shape teaches a call the tool rejects.
  assert.ok(skill.includes('run_in_background'), 'the skill never tells the model how to wait for the lane')
})
