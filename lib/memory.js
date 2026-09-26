/**
 * A durable memory system, for a host that has none.
 *
 * DSH has skills (instructions the agent *loads*) and a session log, but nothing
 * that lets an agent *write down* what it learned and find it again in a later
 * session. This module adds that, and the `<memoryInstructions>` text in
 * `persona.js` that teaches the model to use it. The two are written together
 * and tested together, so the instructions cannot describe a capability the
 * catalog does not have.
 *
 * Three scopes and six commands. Two decisions are worth stating, because both
 * go against the obvious implementation:
 *
 *   - **Storage.** `/memories/` is a virtual path space over three real roots
 *     rather than three directories the model addresses directly, because the
 *     real roots differ per session and must not be writable by path literal.
 *     Session memory is keyed by session id, so two concurrent sessions cannot
 *     collide (see `memory/paths.js`).
 *   - **Session memory lifetime.** Keyed by session id rather than cleared when
 *     a turn ends, because sessions here are durable and resumable — clearing on
 *     exit would lose exactly the notes a resumed session needs.
 *
 * User memory is auto-loaded; session and repository memory are only indexed.
 * That split is the model's cue about what is safe to assume and what it has to
 * go and read.
 *
 * TRUST. This is the one place the plugin writes outside the sandbox, and it is
 * deliberate: routing memory through `ctx.fs` would mean a per-write approval
 * prompt, which would make the feature unusable in exactly the moment it is
 * wanted — after a mistake, mid-task. The exposure is bounded instead of
 * absent: every path is resolved by `memory/paths.js`, which proves containment
 * against the three roots on the real path after symlink resolution, so the tool
 * can create and edit text files in those directories and can do nothing else
 * on the filesystem. It cannot read user files, cannot execute, and cannot write
 * anywhere else. Set `memory: false` to not register it at all.
 *
 * @module dsh-plugin-coding-kit/memory
 */
import { create, insert, move, remove, strReplace, view } from './memory/commands.js'
import { memoryIndexText, userMemoryText } from './memory/sync.js'
import { MEMORY_ROOT, MemoryPathError, resolveRealPath, resolveRoots, scopeOf, toVirtualPath } from './memory/paths.js'

/** The model-facing name, which is also the registry key. */
const TOOL_NAME = 'memory'

/**
 * The tool description the model reads.
 *
 * The command set and the argument names are the contract the
 * `<memoryInstructions>` text refers to, so the two are written together and
 * tested together: if a command is renamed in one, the other has to follow.
 * `view` before `create` is stated up front because a blind `create` is the
 * failure mode this tool has — it refuses to overwrite, so the model discovers
 * a duplicate only after the fact.
 */
const DESCRIPTION = `Store and recall notes across sessions, in three scopes with different lifetimes.

Paths are rooted at ${MEMORY_ROOT}/:
- \`${MEMORY_ROOT}/\` — User memory: survives every workspace and every session. Preferences, recurring commands, patterns, hard-won insights.
- \`${MEMORY_ROOT}/session/\` — Session memory: this conversation only. Task state and in-progress notes. Keyed by session, so a resumed session keeps them and concurrent sessions cannot collide.
- \`${MEMORY_ROOT}/repo/\` — Repository memory: this workspace. Build commands, project structure, conventions that hold here and not elsewhere.

BEFORE CREATING ANYTHING, view ${MEMORY_ROOT}/ to see what already exists. \`create\` fails on an existing path, so an unvisited directory costs a round trip and produces a note that duplicates one you already have.

Commands:
- \`view\`: View contents of a file or list directory contents. Can be used on files or directories (e.g. "${MEMORY_ROOT}/" to see all top-level items).
- \`create\`: Create a new file at the specified path with the given content. Fails if the file already exists.
- \`str_replace\`: Replace an exact string in a file with a new string. The old_str must appear exactly once in the file.
- \`insert\`: Insert text at a specific line number in a file. Line 0 inserts at the beginning.
- \`delete\`: Delete a file or directory (and all its contents).
- \`rename\`: Rename or move a file or directory from path to new_path. Cannot rename across scopes.`

/** The argument schema. Names here are the ones the tool description and the
 * `<memoryInstructions>` text both use. */
const PARAMETERS = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      enum: ['view', 'create', 'str_replace', 'insert', 'delete', 'rename'],
      description: 'The operation to perform on the memory file system.',
    },
    path: {
      type: 'string',
      description: `The absolute path to the file or directory inside ${MEMORY_ROOT}/, e.g. "${MEMORY_ROOT}/notes.md". Used by all commands except \`rename\`.`,
    },
    file_text: { type: 'string', description: 'Required for `create`. The content of the file to create.' },
    old_str: { type: 'string', description: 'Required for `str_replace`. The exact string in the file to replace. Must appear exactly once.' },
    new_str: { type: 'string', description: 'Required for `str_replace`. The new string to replace old_str with.' },
    insert_line: { type: 'number', description: 'Required for `insert`. The 0-based line number to insert text at. 0 inserts before the first line.' },
    insert_text: { type: 'string', description: 'Required for `insert`. The text to insert at the specified line.' },
    view_range: {
      type: 'array',
      items: { type: 'number' },
      description: 'Optional for `view`. A two-element array [start_line, end_line] (1-indexed) to view a specific range of lines.',
    },
    old_path: { type: 'string', description: 'Required for `rename`. The current path of the file or directory to rename.' },
    new_path: { type: 'string', description: 'Required for `rename`. The new path for the file or directory.' },
  },
  required: ['command'],
}

/**
 * The result schema. One flat object across all six commands rather than a
 * discriminated union, because the registry validates results against this and
 * a union would reject the shapes the other commands legitimately return.
 */
const OUTPUT = {
  type: 'object',
  properties: {
    command: { type: 'string' },
    path: { type: 'string' },
    kind: { type: 'string' },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, path: { type: 'string' }, type: { type: 'string' } },
        required: ['name', 'path', 'type'],
      },
    },
    lines: { type: 'array', items: { type: 'string' } },
    text: { type: 'string' },
    totalLines: { type: 'number' },
    startLine: { type: 'number' },
    truncated: { type: 'boolean' },
    lineCount: { type: 'number' },
    created: { type: 'boolean' },
    replaced: { type: 'boolean' },
    insertedAtLine: { type: 'number' },
    deleted: { type: 'boolean' },
    renamedTo: { type: 'string' },
  },
  required: ['command', 'path'],
}

/**
 * Render a result as the content blocks the model reads.
 *
 * The return type is load-bearing and easy to get wrong. `dsh-tools` assigns
 * this function's return value straight to `result.content`:
 *
 *     rendered = tool.output.render(exec.arguments, value)
 *     const content = snapshotProjection(tool.name, "render", rendered)
 *
 * and `createToolResultMessage` then nests it as
 * `{ type: "tool-result", content }`. Every provider adapter walks that array —
 * `contentHasImage` is literally `content.some(...)` — so returning a bare
 * string here does not fail in this plugin. It fails much later, while the next
 * request is being assembled, as an opaque `content.some is not a function` with
 * no component attributed.
 *
 * So this returns a single text block, which is what every harness tool does.
 *
 * The body follows the harness convention of reporting the command, the path
 * touched, and a small summary, so the model can tell a no-op from a real
 * change without re-reading the file.
 *
 * @param args - the tool arguments, for the command being echoed back.
 * @param value - the operation result.
 * @returns one text content block.
 */
function render(args, value) {
  const lines = [`memory ${value.command}: ${value.path}`]
  if (value.kind === 'directory' && value.entries !== undefined) {
    if (value.entries.length === 0) lines.push('(empty directory)')
    for (const entry of value.entries) lines.push(`${entry.type === 'directory' ? 'd ' : '  '} ${entry.path}`)
  } else if (value.lines !== undefined) {
    const body = value.lines
    if (value.truncated === true) lines.push(`(showing lines ${value.startLine}–${value.startLine + value.lines.length - 1} of ${value.totalLines})`)
    lines.push(...body)
  } else if (value.lineCount !== undefined) {
    lines.push(`(file is now ${value.lineCount} lines)`)
  }
  if (value.renamedTo !== undefined) lines.push(`renamed to ${value.renamedTo}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * The tool definition, registered directly rather than through `defineTool`.
 *
 * `defineTool` lives in `@deepseek-ai/dsh-tools`, a host package this plugin
 * cannot resolve from a `link:` install (see `lib/constants.js`); the registry
 * accepts a plain definition, and the only thing given up is schema-coercion of
 * arguments, which `execute` validates itself.
 *
 * @param options - the plugin's resolved config.
 * @returns the tool definition.
 */
function defineMemoryTool({ maxViewBytes, maxWriteBytes, maxListEntries }) {
  return {
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: { schema: OUTPUT, render },
    async execute(rawArgs, exec) {
      const args = rawArgs ?? {}
      const command = args.command
      if (typeof command !== 'string' || !PARAMETERS.properties.command.enum.includes(command)) {
        throw new MemoryPathError(`command must be one of ${PARAMETERS.properties.command.enum.join(', ')}, got ${JSON.stringify(command)}`)
      }
      if (command === 'rename') {
        const source = await contextFor({ path: args.old_path }, exec, 'view')
        const target = await contextFor({ path: args.new_path }, exec, 'view')
        return move(
          { oldPath: source.realPath, newPath: target.realPath, oldVirtualPath: source.displayPath, newVirtualPath: target.displayPath, oldScope: source.scope, newScope: target.scope },
          { roots: source.roots },
        )
      }
      const { roots, displayPath, realPath } = await contextFor(args, exec, command)
      const ctx = { roots, displayPath, maxWriteBytes }
      switch (command) {
        case 'view':
          return view({ ...args, path: realPath, maxBytes: maxViewBytes }, ctx)
        case 'create':
          return create({ ...args, path: realPath }, ctx)
        case 'str_replace':
          return strReplace({ ...args, path: realPath }, ctx)
        case 'insert':
          return insert({ ...args, path: realPath }, ctx)
        case 'delete':
          return remove({ ...args, path: realPath }, ctx)
        /* v8 ignore next 3 -- the enum guard above makes this unreachable */
        default:
          throw new MemoryPathError(`unsupported command: ${command}`)
      }
    },
  }
}

/**
 * Resolve one virtual path against the roots for this call.
 *
 * One resolver for reads and writes: `resolveRealPath` proves containment on the
 * real path in both cases, which is what stops a symlink inside a scope from
 * being either an exfiltration route or an overwrite target.
 *
 * @param args - the tool arguments carrying `path` (or `old_path`).
 * @param exec - the tool execution context.
 * @param command - the command, for error text.
 * @returns the resolved real path, the virtual path to show, the scope, and roots.
 */
async function contextFor(args, exec, command) {
  const roots = rootsFor(exec)
  const virtualPath = typeof args.path === 'string' ? args.path : args.old_path
  if (typeof virtualPath !== 'string' || virtualPath === '') {
    throw new MemoryPathError(`${command === 'rename' ? 'old_path' : 'path'} is required for \`${command}\``)
  }
  return { roots, displayPath: virtualPath, scope: scopeOf(virtualPath), realPath: await resolveRealPath(virtualPath, roots) }
}

/**
 * The roots for one tool call.
 *
 * Read from the execution context rather than captured at registration, because
 * the same standing preset mount serves every session that joins it, and
 * session memory must be keyed per session.
 *
 * @param exec - the tool execution context.
 * @returns the root map.
 */
function rootsFor(exec) {
  const session = exec?.agent?.session
  return resolveRoots({ sessionId: session?.id, cwd: session?.header?.cwd })
}

/** Prompt section orders, just after the persona at 0. */
const USER_MEMORY_ORDER = 1
const MEMORY_INDEX_ORDER = 2

/**
 * Register the tool and the two prompt sections.
 *
 * Both sections are prompt *sections* rather than runtime contexts, so they land
 * in the system message and survive `suppressRuntimeContext()` — memory is
 * content the model needs, not a timestamp that went stale.
 *
 * @param ctx - the plugin context, scoped to the mounting agent preset.
 * @param config - the plugin's resolved config.
 */
function apply(ctx, config) {
  if (config.memory !== true) return

  const autoLoadLines = config.autoLoadLines
  const maxListEntries = config.maxListEntries

  ctx.effect(() => ctx.tools.register(defineMemoryTool({ maxViewBytes: config.maxViewBytes, maxWriteBytes: config.maxWriteBytes, maxListEntries })), 'codingKit.memoryTool()')

  // Auto-loaded user memory, bounded by a line budget rather than the whole scope.
  ctx.effect(
    () => ctx.systemPrompt.section({
      name: 'memory:user',
      order: USER_MEMORY_ORDER,
      // Synchronous by contract, not by preference: the registry calls a
      // section's `text` WITHOUT awaiting it, and `renderPrompt()` immediately
      // calls `.indexOf` on whatever came back. See `memory/sync.js`.
      text: (context) => guarded(() => userMemoryText(rootsFromAssembleContext(context), autoLoadLines)),
    }),
    'codingKit.userMemory()',
  )

  // The index: session and repo memory are listed, never auto-loaded.
  ctx.effect(
    () => ctx.systemPrompt.section({
      name: 'memory:index',
      order: MEMORY_INDEX_ORDER,
      text: (context) => guarded(() => memoryIndexText(rootsFromAssembleContext(context), maxListEntries)),
    }),
    'codingKit.memoryIndex()',
  )
}

/**
 * Run a section text provider, degrading to empty on any failure.
 *
 * Prompt assembly is on the critical path of every model step and this provider
 * reads the filesystem, so a permissions error or a vanished directory must not
 * be able to fail the whole request.
 *
 * @param operation - the provider body.
 * @returns the section text, or `''` when it is absent or not a string.
 */
function guarded(operation) {
  try {
    const text = operation()
    // A type check rather than a promise check, because the failure this guards
    // against surfaces as `text.indexOf is not a function` inside `interpolate` —
    // far from the provider that caused it.
    return typeof text === 'string' ? text : ''
  } catch (error) {
    console.error('coding-kit: memory section failed to render:', error)
    return ''
  }
}

/** The roots for one prompt assembly, from the context the registry supplies. */
function rootsFromAssembleContext(context) {
  const session = context?.agent?.session
  return resolveRoots({ sessionId: session?.id, cwd: session?.header?.cwd })
}

export { MEMORY_ROOT, TOOL_NAME, apply, defineMemoryTool, render, resolveRoots, toVirtualPath }
