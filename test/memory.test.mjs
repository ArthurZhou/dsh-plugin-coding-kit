import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { defineMemoryTool, render } from '../lib/memory.js'
import { MEMORY_ROOT, MemoryPathError, resolveRoots, scopeOf, toRealPath, toVirtualPath } from '../lib/memory/paths.js'

/**
 * The memory tool's tests run against a throwaway harness home and workspace.
 *
 * `DSH_HOME` is what `resolveRoots` reads, so pointing it at a temp directory
 * keeps durable memory out of the real `$DSH_HOME/memories`, and the `repo`
 * scope lands in the temp workspace rather than the checkout.
 */
let home
let workspace
let roots
let exec

const TOOL = defineMemoryTool({ maxViewBytes: 50_000, maxWriteBytes: 200_000, maxListEntries: 200 })
const call = (args) => TOOL.execute(args, exec)

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-mem-home-'))
  workspace = await mkdtemp(join(tmpdir(), 'dsh-mem-ws-'))
  process.env.DSH_HOME = home
  roots = resolveRoots({ sessionId: 'sess-1', cwd: workspace })
  exec = { agent: { session: { id: 'sess-1', header: { cwd: workspace } } } }
})

after(async () => {
  delete process.env.DSH_HOME
  await rm(home, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
})

// ── the tool contract ───────────────────────────────────────────────────────

test('the tool is registered under the name the prompt text refers to', () => {
  assert.equal(TOOL.name, 'memory')
  for (const command of ['view', 'create', 'str_replace', 'insert', 'delete', 'rename']) {
    assert.ok(TOOL.parameters.properties.command.enum.includes(command), `${command} missing`)
    assert.ok(TOOL.description.includes(`\`${command}\``), `${command} is not documented for the model`)
  }
})

test('an unknown command is rejected before any filesystem access', async () => {
  await assert.rejects(() => call({ command: 'exec' }), MemoryPathError)
  await assert.rejects(() => call({}), MemoryPathError)
})

test('results satisfy the declared output schema', async () => {
  const result = await call({ command: 'create', path: `${MEMORY_ROOT}/contract.md`, file_text: 'one\ntwo\n' })
  assert.equal(result.command, 'create')
  assert.equal(result.path, `${MEMORY_ROOT}/contract.md`)
  assert.equal(typeof result.lineCount, 'number')
  for (const [key, value] of Object.entries(result)) {
    assert.ok(key in TOOL.output.schema.properties, `result.${key} is not in the output schema`)
    assert.notEqual(value, undefined, `result.${key} is undefined`)
  }
})

test('render reports the command and the path it touched', async () => {
  const created = await call({ command: 'create', path: `${MEMORY_ROOT}/render.md`, file_text: 'a\nb\nc\n' })
  // `render` returns content blocks, not a string — see test/render.test.mjs for
  // why that shape is load-bearing.
  const content = render({ command: 'create' }, created)
  assert.equal(content.length, 1)
  assert.equal(content[0].type, 'text')
  assert.match(content[0].text, /^memory create: \/memories\/render\.md/)
  assert.match(content[0].text, /file is now 4 lines/)
})

// ── the six commands ────────────────────────────────────────────────────────

test('view lists a directory and reads a file', async () => {
  await call({ command: 'create', path: `${MEMORY_ROOT}/a.md`, file_text: 'l1\nl2\nl3\n' })
  await call({ command: 'create', path: `${MEMORY_ROOT}/nested/b.md`, file_text: 'deep\n' })

  const listing = await call({ command: 'view', path: `${MEMORY_ROOT}/` })
  assert.equal(listing.kind, 'directory')
  const names = listing.entries.map((entry) => entry.path)
  assert.ok(names.includes(`${MEMORY_ROOT}/a.md`))
  assert.ok(names.includes(`${MEMORY_ROOT}/nested`))

  const file = await call({ command: 'view', path: `${MEMORY_ROOT}/a.md` })
  assert.deepEqual(file.lines, ['l1', 'l2', 'l3', ''])
  assert.equal(file.totalLines, 4)

  const ranged = await call({ command: 'view', path: `${MEMORY_ROOT}/a.md`, view_range: [2, 3] })
  assert.deepEqual(ranged.lines, ['l2', 'l3'])
})

test('create refuses to clobber, so a duplicate cannot silently win', async () => {
  await assert.rejects(
    () => call({ command: 'create', path: `${MEMORY_ROOT}/a.md`, file_text: 'other' }),
    /already exists/,
  )
  assert.equal(await readFile(join(roots.user, 'a.md'), 'utf8'), 'l1\nl2\nl3\n')
})

test('str_replace demands a unique match', async () => {
  await call({ command: 'create', path: `${MEMORY_ROOT}/dup.md`, file_text: 'x\nx\n' })
  // Two matches must fail rather than replace the first silently.
  await assert.rejects(() => call({ command: 'str_replace', path: `${MEMORY_ROOT}/dup.md`, old_str: 'x', new_str: 'y' }), /appears 2 times/)
  await assert.rejects(() => call({ command: 'str_replace', path: `${MEMORY_ROOT}/dup.md`, old_str: 'zzz', new_str: 'y' }), /does not appear/)
  const done = await call({ command: 'str_replace', path: `${MEMORY_ROOT}/dup.md`, old_str: 'x\nx', new_str: 'z' })
  assert.equal(done.replaced, true)
  assert.equal(await readFile(join(roots.user, 'dup.md'), 'utf8'), 'z\n')
})

test('insert places text by 0-based line, and 0 is the top', async () => {
  await call({ command: 'create', path: `${MEMORY_ROOT}/ins.md`, file_text: 'b\nc\n' })
  await call({ command: 'insert', path: `${MEMORY_ROOT}/ins.md`, insert_line: 0, insert_text: 'a' })
  assert.equal(await readFile(join(roots.user, 'ins.md'), 'utf8'), 'a\nb\nc\n')
  await call({ command: 'insert', path: `${MEMORY_ROOT}/ins.md`, insert_line: 1, insert_text: 'B' })
  assert.equal(await readFile(join(roots.user, 'ins.md'), 'utf8'), 'a\nB\nb\nc\n')
  await assert.rejects(() => call({ command: 'insert', path: `${MEMORY_ROOT}/ins.md`, insert_line: -1, insert_text: 'x' }), MemoryPathError)
})

test('delete removes a directory and its contents', async () => {
  await call({ command: 'create', path: `${MEMORY_ROOT}/tree/x/y.md`, file_text: 'y\n' })
  const removed = await call({ command: 'delete', path: `${MEMORY_ROOT}/tree` })
  assert.equal(removed.kind, 'directory')
  await assert.rejects(() => call({ command: 'view', path: `${MEMORY_ROOT}/tree/x/y.md` }), MemoryPathError)
})

test('rename refuses to cross scopes, as the captured instructions say', async () => {
  await call({ command: 'create', path: `${MEMORY_ROOT}/session/plan.md`, file_text: 'plan\n' })
  await assert.rejects(
    () => call({ command: 'rename', old_path: `${MEMORY_ROOT}/session/plan.md`, new_path: `${MEMORY_ROOT}/repo/plan.md` }),
    /cannot rename across memory scopes/,
  )
  // Within one scope it works.
  const moved = await call({ command: 'rename', old_path: `${MEMORY_ROOT}/session/plan.md`, new_path: `${MEMORY_ROOT}/session/plan2.md` })
  assert.equal(moved.renamedTo, `${MEMORY_ROOT}/session/plan2.md`)
})

// ── the three scopes ────────────────────────────────────────────────────────

test('each scope writes to its own root, and the virtual path is reversible', async () => {
  await call({ command: 'create', path: `${MEMORY_ROOT}/u.md`, file_text: 'user\n' })
  await call({ command: 'create', path: `${MEMORY_ROOT}/session/s.md`, file_text: 'session\n' })
  await call({ command: 'create', path: `${MEMORY_ROOT}/repo/r.md`, file_text: 'repo\n' })
  assert.equal(await readFile(join(roots.user, 'u.md'), 'utf8'), 'user\n')
  assert.equal(await readFile(join(roots.session, 's.md'), 'utf8'), 'session\n')
  assert.equal(await readFile(join(roots.repo, 'r.md'), 'utf8'), 'repo\n')
  assert.equal(toVirtualPath(join(roots.repo, 'r.md'), roots), `${MEMORY_ROOT}/repo/r.md`)
  assert.equal(toVirtualPath('/etc/passwd', roots), undefined)
})

test('two sessions cannot see each other session memory', async () => {
  await call({ command: 'create', path: `${MEMORY_ROOT}/session/mine.md`, file_text: 'mine\n' })
  const otherRoots = resolveRoots({ sessionId: 'sess-2', cwd: workspace })
  assert.notEqual(roots.session, otherRoots.session)
  assert.ok(roots.session.endsWith('sess-1'))
  const otherExec = { agent: { session: { id: 'sess-2', header: { cwd: workspace } } } }
  const otherTool = defineMemoryTool({ maxViewBytes: 50_000, maxWriteBytes: 200_000, maxListEntries: 200 })
  await assert.rejects(() => otherTool.execute({ command: 'view', path: `${MEMORY_ROOT}/session/mine.md` }, otherExec), /no such memory file/)
})

// ── containment ─────────────────────────────────────────────────────────────

test('a path outside /memories is refused', async () => {
  for (const bad of ['/etc/passwd', '/home/az/.dsh/settings.yaml', 'memories/x.md', '', '/']) {
    await assert.rejects(() => call({ command: 'view', path: bad }), MemoryPathError, `accepted ${JSON.stringify(bad)}`)
  }
})

test('traversal out of a scope is refused', async () => {
  const escapes = [
    `${MEMORY_ROOT}/../settings.yaml`,
    `${MEMORY_ROOT}/session/../../settings.yaml`,
    `${MEMORY_ROOT}/repo/../../../../etc/passwd`,
  ]
  for (const bad of escapes) {
    await assert.rejects(() => call({ command: 'create', path: bad, file_text: 'pwned' }), MemoryPathError, `accepted ${bad}`)
  }
  assert.throws(() => toRealPath(`${MEMORY_ROOT}/../settings.yaml`, roots), MemoryPathError)
})

test('a symlink inside a scope cannot reach outside it', async () => {
  // The classic escape a lexical `..` check misses: the path looks contained,
  // but the final component is a link to somewhere else.
  const outside = join(home, 'outside.txt')
  await writeFile(outside, 'secret\n', 'utf8')
  await symlink(outside, join(roots.user, 'escape.md'))
  await assert.rejects(() => call({ command: 'view', path: `${MEMORY_ROOT}/escape.md` }), /no such memory file|escapes/)
  // And writing through it must not land in the target.
  await assert.rejects(() => call({ command: 'create', path: `${MEMORY_ROOT}/escape.md`, file_text: 'pwned' }), MemoryPathError)
  assert.equal(await readFile(outside, 'utf8'), 'secret\n')
})

test('a create into a not-yet-made directory still proves containment', async () => {
  const made = await call({ command: 'create', path: `${MEMORY_ROOT}/deep/new/dir/note.md`, file_text: 'ok\n' })
  assert.equal(made.created, true)
  const real = join(roots.user, 'deep/new/dir/note.md')
  assert.equal(await readFile(real, 'utf8'), 'ok\n')
  await mkdir(join(roots.user, 'linkdir-parent'), { recursive: true })
  await symlink('/tmp', join(roots.user, 'linkdir-parent', 'away'))
  await assert.rejects(() => call({ command: 'create', path: `${MEMORY_ROOT}/linkdir-parent/away/dsh-mem-escape.md`, file_text: 'pwned' }), MemoryPathError)
})

test('scopeOf classifies the virtual prefixes', () => {
  assert.equal(scopeOf(`${MEMORY_ROOT}/x.md`), 'user')
  assert.equal(scopeOf(`${MEMORY_ROOT}/session/x.md`), 'session')
  assert.equal(scopeOf(`${MEMORY_ROOT}/repo/x.md`), 'repo')
  assert.equal(scopeOf(`${MEMORY_ROOT}/session`), 'session')
  assert.equal(scopeOf('/elsewhere/x.md'), undefined)
})
