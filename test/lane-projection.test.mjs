import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { SOURCE_DIR } from '../lib/install-preset.js'
import { readLane, patchLane } from '../lib/preset-edit.mjs'
import { writeDurable } from '../lib/write-durable.mjs'
import { compositionPaths, normalizeIntent, laneMatchesIntent, projectLane, readLanes, seedIntent } from '../lib/lane-projection.mjs'
import * as host from '../lib/host.mjs'

/**
 * The lane's two editing contracts.
 *
 * ONE: the line editor. `agent.cordis.yml` carries the reasoning behind every
 * row in comments and two `!!js` expressions a YAML parser would mangle, so the
 * composition is edited one line at a time and proved by re-reading the row. The
 * failure this suite exists to catch is the one that looks like success: a write
 * that lands, parses, and has quietly deleted the comments around it.
 *
 * TWO: the projection. The browser cannot write a composition — the stock wire
 * is `settings`, and a custom Typert domain needs generated codecs — so the
 * intent lives in a settings namespace and the host pushes it into the files. A
 * projection that half-applies, or that rewrites a file that already matches, is
 * worse than no projection: it is how a config surface starts making changes
 * nobody asked for.
 */

const composition = await readFile(join(SOURCE_DIR, 'agent.cordis.yml'), 'utf8')

/** One throwaway preset root holding copies of the shipped composition. */
let home
let root

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-lane-'))
  root = join(home, '.agent-presets')
  await mkdir(join(root, 'coding-kit'), { recursive: true })
  await cp(join(SOURCE_DIR, 'agent.cordis.yml'), join(root, 'coding-kit', 'agent.cordis.yml'))
  // A second preset with no lane row at all: most presets have none, and
  // inventing one would put a tool in front of a prompt that never names it.
  await mkdir(join(root, 'standard'), { recursive: true })
  await writeFile(join(root, 'standard', 'agent.cordis.yml'), '- id: tool-bash\n  name: "@deepseek-ai/dsh-tool-bash"\n')
})

after(async () => {
  await rm(home, { recursive: true, force: true })
})

const lanePath = () => join(root, 'coding-kit', 'agent.cordis.yml')
const backups = async () => (await readdir(join(root, 'coding-kit'))).filter((name) => name.includes('.bak-'))

// ── the line editor ─────────────────────────────────────────────────────────

test('the lane reads back out of the shipped composition', () => {
  const lane = readLane(composition)
  assert.equal(lane.toolName, 'subagent_cheap')
  assert.equal(lane.subagentProvider, 'spawn')
  assert.equal(lane.modelProvider, 'openrouter')
  assert.equal(lane.model, 'openai/gpt-6-luna')
  assert.deepEqual(lane.allow, ['read', 'glob', 'grep', 'bash'])
})

test('a no-op patch is byte-identical, comments included', () => {
  const { modelProvider, model, maxTokens, allow, backgroundMode, subagentProvider } = readLane(composition)
  const { text } = patchLane(composition, { modelProvider, model, maxTokens, allow, backgroundMode, subagentProvider })
  assert.equal(text, composition, 'the editor rewrote lines it did not need to touch')
})

test('a patch changes the lane keys and leaves the rest of the file alone', () => {
  const { text, lane } = patchLane(composition, { model: 'z-ai/glm-5.2:free', maxTokens: 4096, allow: ['read', 'grep'] })
  assert.equal(lane.model, 'z-ai/glm-5.2:free')
  assert.equal(lane.maxTokens, 4096)
  assert.deepEqual(lane.allow, ['read', 'grep'])
  const before = composition.split('\n')
  const after = text.split('\n')
  assert.equal(before.length, after.length, 'the patch added or removed lines')
  const differing = before.map((line, i) => (line === after[i] ? undefined : i + 1)).filter((n) => n !== undefined)
  assert.ok(differing.length <= 3, `more lines changed than the three lane keys: ${differing.join(',')}`)
  assert.ok(text.includes('# ── the cheap lane ───'), 'the reasoning above the lane row did not survive')
})

test('the patch cannot reach a sibling row', () => {
  const { text } = patchLane(composition, { subagentProvider: 'fork' })
  const rows = [...text.matchAll(/^ {4}- id: (\S+)$/gm)].map((m) => m[1])
  assert.deepEqual(rows, [...composition.matchAll(/^ {4}- id: (\S+)$/gm)].map((m) => m[1]), 'the row set changed')
  assert.match(text, /toolName: subagent\n/, 'the plain subagent row was edited instead of the lane')
})

test('a patch that cannot land is refused, not written', () => {
  assert.throws(() => patchLane(composition, { allow: [] }), /no tools/)
  // A key the row does not carry must throw rather than append one.
  assert.throws(() => patchLane('    - id: tool-subagent-cheap\n      name: x\n', { model: 'a/b' }), /no "agentOptions:" key/)
  // Nor may a caller invent keys. `toolName` is the one that matters: the
  // persona and the skill both name the lane tool in prose, so renaming it here
  // would leave the prompt routing to a tool that does not exist.
  assert.throws(() => patchLane(composition, { persona: 'x' }), /not editable on the lane row/)
  assert.throws(() => patchLane(composition, { toolName: 'subagent_daily' }), /not editable on the lane row/)
})

// ── the intent the namespace holds ──────────────────────────────────────────

test('an unusable intent is refused before it can reach a file', () => {
  const good = { modelProvider: 'openrouter', model: 'openai/gpt-6-luna', maxTokens: 16384, allow: ['read'] }
  assert.deepEqual(normalizeIntent(good), good)
  assert.throws(() => normalizeIntent({ ...good, allow: [] }), /at least one tool/)
  assert.throws(() => normalizeIntent({ ...good, maxTokens: 12.5 }), /positive whole number/)
  assert.throws(() => normalizeIntent({ ...good, model: '' }), /needs a model id/)
  assert.throws(() => normalizeIntent({ ...good, modelProvider: '' }), /needs a provider route/)
})

test('matching is exact, including the tool list', () => {
  const lane = readLane(composition)
  assert.equal(laneMatchesIntent(lane, { modelProvider: lane.modelProvider, model: lane.model, maxTokens: lane.maxTokens, allow: ['read'] }), false, 'a shorter tool list must not match')
  assert.equal(laneMatchesIntent(lane, { modelProvider: lane.modelProvider, model: lane.model, maxTokens: lane.maxTokens, allow: [...lane.allow] }), true)
})

// ── the projection ──────────────────────────────────────────────────────────

test('preset discovery finds compositions and reads only the ones with a lane', async () => {
  const found = await compositionPaths([root])
  assert.deepEqual(found.map((entry) => entry.id).sort(), ['coding-kit', 'standard'])
  const lanes = await readLanes(found.map((entry) => entry.path))
  assert.deepEqual(lanes.map((entry) => entry.path), [lanePath()], 'a preset without a lane row must not produce a lane')
})

test('projecting rewrites the lane, keeps the comments, and backs the file up', async () => {
  const result = await projectLane([lanePath()], { modelProvider: 'openrouter', model: 'google/gemma-4-31b-it:free', maxTokens: 32768, allow: ['read', 'grep'] })
  assert.deepEqual(result.failed, [])
  assert.equal(result.applied.length, 1)
  const text = await readFile(lanePath(), 'utf8')
  const lane = readLane(text)
  assert.equal(lane.model, 'google/gemma-4-31b-it:free')
  assert.equal(lane.maxTokens, 32768)
  assert.deepEqual(lane.allow, ['read', 'grep'])
  assert.ok(text.includes('# ── the cheap lane ───'), 'the comments did not survive a projection')
  assert.equal((await backups()).length, 1, 'the projection left no backup')
})

test('projecting the value already in place writes nothing', async () => {
  const before = await readFile(lanePath(), 'utf8')
  const result = await projectLane([lanePath()], { modelProvider: 'openrouter', model: 'google/gemma-4-31b-it:free', maxTokens: 32768, allow: ['read', 'grep'] })
  assert.deepEqual(result.applied, [])
  assert.equal(result.skipped.length, 1)
  assert.equal(await readFile(lanePath(), 'utf8'), before, 'an idempotent projection still rewrote the file')
  assert.equal((await backups()).length, 1, 'an idempotent projection still made a backup')
})

test('a preset with no lane row is neither touched nor reported as a failure', async () => {
  const path = join(root, 'standard', 'agent.cordis.yml')
  const result = await projectLane([path], { modelProvider: 'openrouter', model: 'openai/gpt-6-luna', maxTokens: 16384, allow: ['read'] })
  assert.deepEqual(result, { applied: [], skipped: [], failed: [] })
  assert.equal(await readFile(path, 'utf8'), '- id: tool-bash\n  name: "@deepseek-ai/dsh-tool-bash"\n')
})

test('seeding reads the shipped row, and invents nothing when there is none', async () => {
  assert.equal(await seedIntent([join(root, 'standard', 'agent.cordis.yml')]), undefined)
  const fromLane = await seedIntent([lanePath()])
  assert.equal(fromLane.model, 'google/gemma-4-31b-it:free')
  assert.deepEqual(fromLane.allow, ['read', 'grep'])
})

// ── the write itself ────────────────────────────────────────────────────────

test('a file that fails its own check never replaces a working one', async () => {
  const path = join(home, 'guarded.yml')
  await writeFile(path, 'original\n')
  await assert.rejects(() => writeDurable(path, 'replacement\n', { validate: () => { throw new Error('nope') } }), /refusing to write/)
  assert.equal(await readFile(path, 'utf8'), 'original\n')
  assert.deepEqual((await readdir(home)).filter((name) => name.endsWith('.tmp-')), [], 'a refused write left a temporary file behind')
})

test('a write that lands but does not verify is reported, not assumed good', async () => {
  const path = join(home, 'verifying.yml')
  await writeFile(path, 'a\n')
  await assert.rejects(() => writeDurable(path, 'b\n', { verify: () => { throw new Error('did not stick') } }), /does not verify/)
  assert.equal(await readFile(path, 'utf8'), 'b\n', 'the write itself is atomic and did land')
})

// ── the host half ───────────────────────────────────────────────────────────

test('the host half registers one namespace and no tools', () => {
  assert.equal(host.name, 'coding-kit-lane')
  assert.equal(host.NAMESPACE, 'cheap-lane')
  assert.deepEqual(host.inject, ['settings'], 'the host row must not join the tool or prompt registries')
})
