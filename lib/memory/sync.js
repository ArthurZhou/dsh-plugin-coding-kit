/**
 * Synchronous readers for the memory prompt sections.
 *
 * WHY THESE EXIST AS A SEPARATE MODULE. `dsh-system-prompt` calls a section's
 * `text` provider like this:
 *
 *     text: typeof section.text === 'function' ? section.text(context) : section.text
 *
 * with no `await`, and `renderPrompt()` then runs `interpolate()` over the result
 * synchronously. A provider declared `async` therefore hands the renderer a
 * Promise, and the first thing `interpolate` does is `text.indexOf(...)` — which
 * fails with `text.indexOf is not a function`, once per request, taking the whole
 * turn with it. Contexts are assembled the same way.
 *
 * So a section's `text` must be a plain function returning a string. The cost of
 * honouring that is blocking reads at assembly time, which is acceptable here
 * precisely because the data is tiny and bounded: a handful of short `.md` files
 * and two capped directory walks, once per model step.
 *
 * Every function degrades rather than throws. A memory problem must not be able
 * to break prompt assembly for the whole agent.
 *
 * @module dsh-plugin-coding-kit/memory/sync
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { MEMORY_ROOT, toVirtualPath } from './paths.js'

/**
 * The first `maxLines` lines across a root's top-level markdown files.
 *
 * The auto-load budget is a line count rather than a byte count, and the
 * per-file order is filename order, so the prefix is stable between steps.
 *
 * @param root - an absolute real root.
 * @param maxLines - the line budget; `0` disables auto-loading entirely.
 * @returns the loaded text and the files it came from, or `undefined` on failure.
 */
export function readAutoLoadSync(root, maxLines) {
  if (maxLines <= 0) return { text: '', files: [] }
  const entries = safe(() => readdirSync(root, { withFileTypes: true }), undefined)
  if (entries === undefined) return { text: '', files: [] }
  const files = []
  const chunks = []
  let budget = maxLines
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith('.md')).sort((a, b) => a.name.localeCompare(b.name))) {
    if (budget <= 0) break
    const text = safe(() => readFileSync(join(root, entry.name), 'utf8'), undefined)
    if (text === undefined) continue
    const lines = text.split('\n')
    const taken = lines.slice(0, budget)
    budget -= taken.length
    files.push({ name: entry.name, lines: taken.length, totalLines: lines.length })
    chunks.push(`### ${entry.name}\n${taken.join('\n')}`)
  }
  return { text: chunks.join('\n\n'), files }
}

/**
 * Every memory file under a root, as virtual paths, directories first.
 *
 * Backs the index section, which lists session and repo memory without loading
 * their contents — the split the captured `<memoryInstructions>` describes.
 *
 * @param root - an absolute real root.
 * @param roots - the full root map, for rendering virtual paths.
 * @param options - `maxEntries` caps the walk so a runaway tree cannot stall a step.
 * @returns one entry per file and directory, or `undefined` on failure.
 */
export function listAllSync(root, roots, { maxEntries = 200 } = {}) {
  const found = []
  const walk = (dir) => {
    if (found.length >= maxEntries) return
    const entries = safe(() => readdirSync(dir, { withFileTypes: true }), undefined)
    if (entries === undefined) return
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= maxEntries) return
      if (entry.name.startsWith('.')) continue
      const childReal = join(dir, entry.name)
      const virtual = toVirtualPath(childReal, roots)
      if (virtual === undefined) continue
      if (entry.isDirectory()) {
        found.push({ path: virtual, type: 'directory' })
        walk(childReal)
      } else if (entry.isFile()) {
        found.push({ path: virtual, type: 'file' })
      }
    }
  }
  walk(resolve(root))
  return found
}

/**
 * Neutralise prompt-variable references in injected content.
 *
 * `dsh-system-prompt`'s `interpolate()` runs over EVERY section's text and
 * treats any `{{name}}` as a variable reference: it substitutes the registered
 * ones (`provider`, `model`, `cwd`) and throws `unknown prompt variable` for
 * every other. It applies to the whole section string, with no way to opt out of
 * a region.
 *
 * That makes free text dangerous to inject. Memory files are written by the
 * agent and by the user, so a note containing a template literal, JSX, a Go
 * format string — or a note *about* template literals — would fail every single
 * request. And a `{{model}}` in a memory file would be silently substituted, so
 * the prompt would claim the file says something it does not.
 *
 * So every `{{` in injected content is split with a zero-width space. The
 * renderer only enters its scan at a literal `{{`, so removing every one of them
 * makes the text inert; the character is invisible, so the prose still reads
 * correctly and the model still sees what the file actually says. The file on
 * disk is never modified — this affects the injected copy only, and the `memory`
 * tool still serves exact bytes.
 *
 * Runs of braces are handled as a unit, not pairwise: `String.replaceAll` does
 * not match overlaps, so `{{{name}}}` would become `{<zwsp>{{name}}}` and keep a
 * live `{{` behind. Every brace after the first in a run gets a zero-width space,
 * which leaves no `{{` in one pass for any run length.
 *
 * @param text - the content to make interpolation-safe.
 * @returns the same text with no `{{` sequence remaining.
 */
export function escapeInterpolation(text) {
  return text.replace(/\{{2,}/g, (run) => [...run].map((brace, index) => (index === 0 ? brace : `\u200B${brace}`)).join(''))
}

/**
 * The auto-loaded user memory section, as a string.
 *
 * @param roots - the resolved roots.
 * @param autoLoadLines - the line budget.
 * @returns the section text, or `''` when there is nothing to load — an empty
 * section is dropped by `renderPrompt()`, which is the way to contribute nothing.
 */
export function userMemoryText(roots, autoLoadLines) {
  const { text, files } = readAutoLoadSync(roots.user, autoLoadLines)
  if (text === '') return ''
  const listed = files.map((file) => `(${file.lines}/${file.totalLines} lines of ${file.name})`).join(' ')
  return escapeInterpolation(`User memory, auto-loaded from ${MEMORY_ROOT}/ (first ${autoLoadLines} lines) ${listed}:\n\n${text}`)
}

/**
 * The memory index section, as a string.
 *
 * @param roots - the resolved roots.
 * @param maxListEntries - the per-scope walk cap.
 * @returns the section text.
 */
export function memoryIndexText(roots, maxListEntries) {
  const sessionEntries = listAllSync(roots.session, roots, { maxEntries: maxListEntries })
  const repoEntries = listAllSync(roots.repo, roots, { maxEntries: maxListEntries })
  const block = (title, entries) => (entries.length === 0 ? `${title}: none yet — use the \`memory\` tool to create one.` : `${title}:\n${entries.map((entry) => `- ${entry.path}`).join('\n')}`)
  return escapeInterpolation(`<memoryIndex>\n${block(`Session memory (${MEMORY_ROOT}/session/)`, sessionEntries)}\n${block(`Repository memory (${MEMORY_ROOT}/repo/)`, repoEntries)}\nSession and repository memory are listed here, not loaded. Read a file with the \`memory\` tool when you need it.\n</memoryIndex>`)
}

function safe(operation, fallback) {
  try {
    return operation()
  } catch {
    return fallback
  }
}
