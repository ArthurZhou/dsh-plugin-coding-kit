import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { FILES, PRESET_ID, SOURCE_DIR, apply, install, name, presetRoot } from '../lib/install-preset.js'

/**
 * The preset installer's guarantees.
 *
 * The two that matter and are easy to get wrong:
 *   - it must never clobber a preset the user has edited, on any later boot;
 *   - it must never fail a boot. A missing preset is one fewer option in a
 *     picker; a thrown error here takes the whole harness down.
 */
let home
let root

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-preset-home-'))
  process.env.DSH_HOME = home
  root = join(home, '.agent-presets')
})

after(async () => {
  delete process.env.DSH_HOME
  await rm(home, { recursive: true, force: true })
})

beforeEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test('the row is a valid composition entry', () => {
  assert.equal(name, 'coding-kit-preset')
  assert.deepEqual(FILES, ['agent.cordis.yml', 'preset.yml'])
  assert.equal(PRESET_ID, 'coding-kit')
})

test('the shipped preset is what the package says it is', async () => {
  // The files the installer copies are the package's own, so a broken preset
  // would be discovered rather than skipped.
  const composition = await readFile(join(SOURCE_DIR, 'agent.cordis.yml'), 'utf8')
  const metadata = await readFile(join(SOURCE_DIR, 'preset.yml'), 'utf8')
  assert.ok(composition.includes("name: 'dsh-plugin-coding-kit'"), 'the preset does not mount the plugin')
  assert.ok(metadata.includes('name:'), 'preset.yml has no display name')
})

test('presetRoot follows DSH_HOME, like the roster does', () => {
  assert.equal(presetRoot(), join(home, '.agent-presets'))
})

test('a fresh profile gets the preset', async () => {
  const target = join(root, 'coding-kit')
  assert.equal(await install('coding-kit', target, false), target)
  for (const file of FILES) {
    const content = await readFile(join(target, file), 'utf8')
    assert.ok(content.length > 0, `${file} was installed empty`)
  }
})

test('a second boot does not touch an existing preset', async () => {
  const target = join(root, 'coding-kit')
  await install('coding-kit', target, false) // the first boot
  const edited = '# MINE — the user edited this\n'
  await writeFile(join(target, 'agent.cordis.yml'), edited, 'utf8')

  assert.equal(await install('coding-kit', target, false), undefined, 'it claimed to install over an existing preset')
  assert.equal(await readFile(join(target, 'agent.cordis.yml'), 'utf8'), edited, 'the user edit was clobbered')
})

test('a half-copied preset is finished, not skipped or duplicated', async () => {
  // An interrupted boot can leave one file present and one missing.
  const target = join(root, 'coding-kit')
  await rm(join(target, 'preset.yml'), { force: true })
  assert.equal(await install('coding-kit', target, false), target)
  const restored = await readFile(join(target, 'preset.yml'), 'utf8')
  assert.equal(restored, await readFile(join(SOURCE_DIR, 'preset.yml'), 'utf8'))
})

test('overwrite: true refreshes, for anyone who wants it', async () => {
  const target = join(root, 'coding-kit')
  await install('coding-kit', target, false)
  await writeFile(join(target, 'agent.cordis.yml'), '# stale\n', 'utf8')
  assert.equal(await install('coding-kit', target, true), target)
  assert.equal(await readFile(join(target, 'agent.cordis.yml'), 'utf8'), await readFile(join(SOURCE_DIR, 'agent.cordis.yml'), 'utf8'))
})

test('a custom id installs under that id', async () => {
  const target = join(root, 'coding-kit-zh')
  await install('coding-kit-zh', target, false)
  const list = await readFile(join(target, 'agent.cordis.yml'), 'utf8')
  assert.ok(list.includes("name: 'dsh-plugin-coding-kit'"))
})

test('apply() never throws, whatever DSH_HOME points at', async () => {
  // A boot must survive a bad home, a read-only root, or anything else.
  const unwritable = join(home, 'nope', '\0invalid')
  process.env.DSH_HOME = unwritable
  try {
    assert.doesNotThrow(() => apply({}, {}))
  } finally {
    process.env.DSH_HOME = home
  }
})

test('apply() survives a row with no config block, as the shipped one has', async () => {
  // The composition row carries no `config:`, so Cordis hands `apply` undefined.
  // Reading config.id unguarded took the whole host boot down.
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await assert.doesNotReject(() => apply({}, undefined))
  const content = await readFile(join(root, 'coding-kit', 'agent.cordis.yml'), 'utf8')
  assert.ok(content.includes("name: 'dsh-plugin-coding-kit'"))
})

test('apply() installs through the plugin config', async () => {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await apply({}, {})
  const content = await readFile(join(root, 'coding-kit', 'agent.cordis.yml'), 'utf8')
  assert.ok(content.includes("name: 'dsh-plugin-coding-kit'"))
})
