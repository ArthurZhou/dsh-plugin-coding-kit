/**
 * The six memory commands: `view`, `create`, `str_replace`, `insert`, `delete`,
 * `rename`. Two of their semantics are deliberate and tested — `str_replace`
 * requires a unique match, and `rename` refuses to cross scopes — because the
 * `<memoryInstructions>` text tells the model both hold, and a model that is
 * wrong about that writes to the wrong place.
 *
 * What is left is plumbing: real paths, bounded reads, and error text the model
 * can act on without guessing.
 *
 * Every function here takes an already-resolved real path, so containment is
 * settled in `paths.js` before any of this runs.
 *
 * @module dsh-plugin-coding-kit/memory/commands
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { MemoryPathError, toVirtualPath } from './paths.js'

/** Largest file `view` will read, matching the harness's read budget. */
const MAX_VIEW_BYTES = 50_000
/** Largest `create` payload accepted. */
const MAX_WRITE_BYTES = 200_000

/**
 * View a file, or list a directory.
 *
 * @param args - `{ path, view_range?, maxBytes?, maxLines? }` with a real `path`.
 * @param ctx - `{ roots, displayPath }` for rendering virtual paths.
 * @returns the operation's result object, matching the tool's output schema.
 */
export async function view(args, ctx) {
  const info = await statOrNull(args.path)
  if (info === undefined) throw new MemoryPathError(`no such memory file or directory: ${ctx.displayPath}`)
  if (info.isDirectory()) return { command: 'view', path: ctx.displayPath, kind: 'directory', entries: await listDirectory(args.path, ctx) }
  if (!info.isFile()) throw new MemoryPathError(`not a regular file: ${ctx.displayPath}`)

  const size = info.size
  const truncated = size > (args.maxBytes ?? MAX_VIEW_BYTES)
  const text = await readFile(args.path, 'utf8')
  const lines = text.split('\n')
  const totalLines = lines.length
  // No range means "the whole file", bounded by `maxLines`. An explicit range is
  // validated; the default is not, because a synthetic `Infinity` end would fail
  // the same integer check a model-supplied value has to pass.
  const range = args.view_range
  if (range !== undefined && (!Array.isArray(range) || range.length !== 2 || !Number.isInteger(range[0]) || !Number.isInteger(range[1]) || range[0] < 1 || range[1] < range[0])) {
    throw new MemoryPathError(`view_range must be [start, end] with 1 <= start <= end, got ${JSON.stringify(range)}`)
  }
  const start = range?.[0] ?? 1
  const end = range?.[1] ?? (args.maxLines === undefined ? lines.length : Math.min(lines.length, start - 1 + args.maxLines))
  const selected = lines.slice(start - 1, end)
  return {
    command: 'view',
    path: ctx.displayPath,
    kind: 'file',
    startLine: start,
    totalLines,
    truncated,
    lines: selected,
    text: selected.join('\n'),
  }
}

async function listDirectory(realPath, ctx) {
  const entries = await readdir(realPath, { withFileTypes: true })
  return entries
    .map((entry) => {
      const childReal = join(realPath, entry.name)
      const childVirtual = toVirtualPath(childReal, ctx.roots)
      return { name: entry.name, path: childVirtual ?? join(ctx.displayPath, entry.name).replace(/\/+/g, '/'), type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' }
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1))
}

/**
 * Create a new file. Fails if it already exists — the description tells the
 * model to `view` the directory first precisely so it updates rather than
 * duplicates, and a silent overwrite is the failure this refuses to allow.
 *
 * @param args - `{ path, fileText }` with a real `path`.
 * @param ctx - rendering context.
 * @returns the result object.
 */
export async function create(args, ctx) {
  const maxWriteBytes = ctx.maxWriteBytes ?? MAX_WRITE_BYTES
  if (typeof args.file_text !== 'string') throw new MemoryPathError('file_text is required for `create`')
  if (Buffer.byteLength(args.file_text) > maxWriteBytes) throw new MemoryPathError(`file_text exceeds the ${maxWriteBytes}-byte limit`)
  if (await exists(args.path)) throw new MemoryPathError(`already exists — use \`str_replace\` or \`insert\` to change it: ${ctx.displayPath}`)
  await mkdir(dirname(args.path), { recursive: true })
  await writeFile(args.path, args.file_text, 'utf8')
  const lines = args.file_text.split('\n').length
  return { command: 'create', path: ctx.displayPath, created: true, lineCount: lines }
}

/**
 * Replace an exact string, which must appear exactly once.
 *
 * The uniqueness requirement is load-bearing: a silent multi-match replace is
 * how a wrong hunk gets written into a file the model believed it had edited
 * deliberately, and the model would never learn of it.
 *
 * @param args - `{ path, oldStr, newStr }` with a real `path`.
 * @param ctx - rendering context.
 * @returns the result object.
 */
export async function strReplace(args, ctx) {
  if (typeof args.old_str !== 'string' || typeof args.new_str !== 'string') {
    throw new MemoryPathError('old_str and new_str are both required for `str_replace`')
  }
  const info = await statOrNull(args.path)
  if (info === undefined || !info.isFile()) throw new MemoryPathError(`no such memory file: ${ctx.displayPath}`)
  const text = await readFile(args.path, 'utf8')
  const occurrences = countOccurrences(text, args.old_str)
  if (occurrences === 0) throw new MemoryPathError(`old_str does not appear in ${ctx.displayPath} — read the file and copy the text exactly`)
  if (occurrences > 1) {
    throw new MemoryPathError(`old_str appears ${occurrences} times in ${ctx.displayPath}; it must appear exactly once — include more surrounding context to make it unique`)
  }
  const updated = text.replace(args.old_str, args.new_str)
  await writeFile(args.path, updated, 'utf8')
  return { command: 'str_replace', path: ctx.displayPath, replaced: true, lineCount: updated.split('\n').length }
}

function countOccurrences(haystack, needle) {
  if (needle === '') return Infinity
  let count = 0
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/**
 * Insert text at a 0-based line. Line 0 inserts before the first line.
 *
 * @param args - `{ path, insertLine, insertText }` with a real `path`.
 * @param ctx - rendering context.
 * @returns the result object.
 */
export async function insert(args, ctx) {
  if (!Number.isInteger(args.insert_line) || args.insert_line < 0) {
    throw new MemoryPathError(`insert_line must be a non-negative integer, got ${JSON.stringify(args.insert_line)}`)
  }
  if (typeof args.insert_text !== 'string') throw new MemoryPathError('insert_text is required for `insert`')
  const info = await statOrNull(args.path)
  if (info === undefined || !info.isFile()) throw new MemoryPathError(`no such memory file: ${ctx.displayPath}`)
  const lines = (await readFile(args.path, 'utf8')).split('\n')
  const at = Math.min(args.insert_line, lines.length)
  lines.splice(at, 0, ...args.insert_text.split('\n'))
  const text = lines.join('\n')
  await writeFile(args.path, text, 'utf8')
  return { command: 'insert', path: ctx.displayPath, insertedAtLine: at, lineCount: lines.length }
}

/**
 * Delete a file or a directory and its contents.
 *
 * @param args - `{ path }` with a real `path`.
 * @param ctx - rendering context.
 * @returns the result object.
 */
export async function remove(args, ctx) {
  const info = await statOrNull(args.path)
  if (info === undefined) throw new MemoryPathError(`no such memory file or directory: ${ctx.displayPath}`)
  await rm(args.path, { recursive: true, force: true })
  return { command: 'delete', path: ctx.displayPath, deleted: true, kind: info.isDirectory() ? 'directory' : 'file' }
}

/**
 * Rename or move, refusing to cross scopes.
 *
 * The tool description states the refusal and the model relies on it, so it is
 * enforced here rather than left to the path mapper: a cross-scope move would
 * otherwise be silently reinterpreted against a different root and land in the
 * wrong place.
 *
 * @param args - `{ oldPath, newPath }`, both already resolved to real paths.
 * @param ctx - rendering context.
 * @returns the result object.
 */
export async function move(args, ctx) {
  if (args.oldScope === undefined || args.newScope === undefined) throw new MemoryPathError('rename needs both old_path and new_path')
  if (args.oldScope !== args.newScope) {
    throw new MemoryPathError(`cannot rename across memory scopes (${args.oldScope} → ${args.newScope}); create the file in the target scope instead`)
  }
  if (args.oldPath === args.newPath) throw new MemoryPathError('old_path and new_path are the same')
  if (await exists(args.newPath)) throw new MemoryPathError(`already exists: ${args.newVirtualPath}`)
  const info = await statOrNull(args.oldPath)
  if (info === undefined) throw new MemoryPathError(`no such memory file or directory: ${args.oldVirtualPath}`)
  await mkdir(dirname(args.newPath), { recursive: true })
  await rename(args.oldPath, args.newPath)
  return { command: 'rename', path: args.oldVirtualPath, renamedTo: args.newVirtualPath, kind: info.isDirectory() ? 'directory' : 'file' }
}

async function statOrNull(path) {
  try {
    return await stat(path)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
    throw error
  }
}

async function exists(path) {
  return (await statOrNull(path)) !== undefined
}
