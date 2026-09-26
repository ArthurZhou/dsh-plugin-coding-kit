import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { defineMemoryTool, render } from '../lib/memory.js'

/**
 * `output.render` must return CONTENT BLOCKS, not text.
 *
 * `dsh-tools` does this:
 *
 *     rendered = tool.output.render(exec.arguments, value)
 *     const content = snapshotProjection(tool.name, "render", rendered)
 *
 * and `createToolResultMessage` nests the result as
 * `{ type: "tool-result", content }`. Every provider adapter then walks that
 * array — `contentHasImage` in `dsh-llm` is literally `content.some(...)`.
 *
 * A tool whose render returns a bare string therefore registers and executes
 * perfectly, and only fails on the *next* request while the adapter assembles
 * it, as `content.some is not a function` with no component attributed. These
 * tests apply the contract exactly as the registry does, so that failure cannot
 * reach a user again.
 */
let home
let workspace
let roots
let exec

const TOOL = defineMemoryTool({ maxViewBytes: 50_000, maxWriteBytes: 200_000, maxListEntries: 200 })

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-render-home-'))
  workspace = await mkdtemp(join(tmpdir(), 'dsh-render-ws-'))
  process.env.DSH_HOME = home
  exec = { agent: { session: { id: 'render', header: { cwd: workspace } } } }
})

/**
 * Recreate the seed memory for one test. The cases below mutate files — a
 * `str_replace` consumes its own `old_str`, a `delete` consumes its file — so
 * they are not idempotent and cannot share state across tests.
 */
async function freshState() {
  await rm(home, { recursive: true, force: true })
  // Session memory is keyed by session id, and `exec` above uses id `render`.
  await mkdir(join(home, 'memories', 'session', 'render'), { recursive: true })
  await writeFile(join(home, 'memories', 'notes.md'), 'alpha\nbeta\n', 'utf8')
  await writeFile(join(home, 'memories', 'session', 'render', 'plan.md'), 'step one\n', 'utf8')
}

after(async () => {
  delete process.env.DSH_HOME
  await rm(home, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
})

/** What the registry does with a render result, verbatim. */
function asRegistryContent(value) {
  const content = render(value.args, value.value)
  // What createToolResultMessage builds, and what every adapter walks.
  return [{ type: 'tool-result', toolCallId: 'call-1', content, isError: false }]
}

/** What `dsh-llm`'s `contentHasImage` does on the first line. */
function contentHasImage(content) {
  return content.some((block) => block.type === 'image' || (block.type === 'tool-result' && contentHasImage(block.content)))
}

const CASES = [
  { label: 'view a file', args: { command: 'view', path: '/memories/notes.md' } },
  { label: 'view a directory', args: { command: 'view', path: '/memories/' } },
  { label: 'view a range', args: { command: 'view', path: '/memories/notes.md', view_range: [1, 1] } },
  { label: 'create', args: { command: 'create', path: '/memories/fresh.md', file_text: 'new\n' } },
  { label: 'str_replace', args: { command: 'str_replace', path: '/memories/notes.md', old_str: 'alpha', new_str: 'ALPHA' } },
  { label: 'insert', args: { command: 'insert', path: '/memories/notes.md', insert_line: 0, insert_text: 'top' } },
  { label: 'delete', args: { command: 'delete', path: '/memories/session/plan.md' } },
  { label: 'rename', args: { command: 'rename', old_path: '/memories/fresh.md', new_path: '/memories/renamed.md' } },
]

test('render returns an array for every command', async () => {
  await freshState()
  for (const { label, args } of CASES) {
    const value = await TOOL.execute(args, exec)
    const content = render(args, value)
    assert.ok(Array.isArray(content), `${label}: render returned ${typeof content}, not an array`)
    assert.ok(content.length > 0, `${label}: render returned an empty array`)
  }
})

test('every rendered block is a well-formed text block', async () => {
  await freshState()
  for (const { label, args } of CASES) {
    const value = await TOOL.execute(args, exec)
    for (const block of render(args, value)) {
      assert.equal(typeof block, 'object', `${label}: block is not an object`)
      assert.equal(block.type, 'text', `${label}: block type is ${JSON.stringify(block.type)}`)
      assert.equal(typeof block.text, 'string', `${label}: block text is ${typeof block.text}`)
    }
  }
})

test('the registry can nest and walk the content without throwing', async () => {
  await freshState()
  for (const { label, args } of CASES) {
    const value = await TOOL.execute(args, exec)
    const content = asRegistryContent({ args, value })
    assert.equal(typeof contentHasImage(content), 'boolean', `${label}: contentHasImage threw`)
    // The second hop is the one that recurses into a tool-result block.
    assert.equal(contentHasImage(content[0].content), false, `${label}: reported a phantom image`)
  }
})

test('the render output is lossless JSON, as snapshotProjection requires', async () => {
  await freshState()
  for (const { label, args } of CASES) {
    const value = await TOOL.execute(args, exec)
    const content = render(args, value)
    assert.deepEqual(JSON.parse(JSON.stringify(content)), content, `${label}: render output is not lossless JSON`)
  }
})

test('the model still sees the command, the path, and the body', async () => {
  await freshState()
  const args = { command: 'view', path: '/memories/notes.md' }
  const text = render(args, await TOOL.execute(args, exec))[0].text
  assert.match(text, /^memory view: \/memories\/notes\.md/)
  assert.ok(text.includes('beta'), 'the file body is missing from the rendered text')
})

test('a directory listing renders one line per entry', async () => {
  await freshState()
  const args = { command: 'view', path: '/memories/' }
  const text = render(args, await TOOL.execute(args, exec))[0].text
  assert.ok(text.includes('/memories/notes.md'), 'the listing lost a file')
})
