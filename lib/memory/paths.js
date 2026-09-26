/**
 * The virtual memory path space and its containment rules.
 *
 * The model addresses memory through a virtual `/memories/…` space, which is what
 * the `<memoryInstructions>` text describes, so that text and the tool agree by
 * construction. Behind it sit three real directories with different lifetimes:
 *
 *   /memories/         user     durable across workspaces and conversations
 *   /memories/session/ session  one conversation; keyed by session id
 *   /memories/repo/    repo     this workspace only
 *
 * This module owns the only security-relevant logic in the plugin: every path a
 * tool call carries is resolved here, and nothing outside the three roots is
 * ever reachable. Containment is checked on the *real* path after symlink
 * resolution, because a lexical `..` check alone is defeated by a symlink
 * planted inside a memory directory.
 *
 * @module dsh-plugin-coding-kit/memory/paths
 */
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

/** The virtual prefix the model sees. */
export const MEMORY_ROOT = '/memories'

/** The three scopes, in the order `<memoryInstructions>` lists them. */
export const SCOPES = /** @type {const} */ (['user', 'session', 'repo'])

/** The scopes that have their own subdirectory; `user` is `/memories/` itself. */
const NAMED_SCOPES = ['session', 'repo']

/** Thrown for a path the memory file system refuses. Carries no stack: it is a
 * model-facing argument error, not a crash. */
export class MemoryPathError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MemoryPathError'
  }
}

/**
 * The harness home, where durable memory lives.
 *
 * Read from the environment rather than through `@deepseek-ai/dsh-home-paths`:
 * that is a host package, and a `link:`-installed plugin resolves from its own
 * checkout, where the host tree is not on the lookup path (see
 * `lib/constants.js` for the same reasoning).
 *
 * @returns the absolute harness home directory.
 */
export function harnessHome() {
  const fromEnv = process.env.DSH_HOME
  return resolve(fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh'))
}

/**
 * Resolve the three real roots for one session.
 *
 * Session memory is keyed by session id rather than shared, so two concurrent
 * sessions in one harness cannot read or clobber each other's notes — the
 * virtual `/memories/session/` prefix stays stable for the model while
 * the storage stays isolated.
 *
 * @param options - the resolved roots' inputs.
 * @param options.sessionId - the owning session, or `undefined` outside a session.
 * @param options.cwd - the workspace root, which anchors repo memory.
 * @param options.directoryName - the directory under each root, for repos that
 *   keep harness state somewhere other than the default.
 * @returns one absolute directory per scope, in {@link SCOPES} order.
 */
export function resolveRoots({ sessionId, cwd, directoryName = 'memories' }) {
  const home = harnessHome()
  const user = join(home, directoryName)
  const session = sessionId === undefined ? join(home, directoryName, 'session') : join(home, directoryName, 'session', safeId(sessionId))
  const repo = join(resolve(cwd ?? process.cwd()), '.dsh', directoryName)
  return { user, session, repo }
}

/** Reduce an arbitrary session id to one safe path segment. */
function safeId(sessionId) {
  const cleaned = String(sessionId).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned === '' ? 'default' : cleaned.slice(0, 128)
}

/**
 * Which scope a virtual path belongs to.
 *
 * The user scope is not a subdirectory — it is `/memories/` itself — so it is
 * the fallback rather than a prefix like the other two. The two named scopes are
 * tested first, because a path under `/memories/session/` is also, trivially,
 * under `/memories/`.
 *
 * @param virtualPath - an absolute path under {@link MEMORY_ROOT}.
 * @returns the scope name, or `undefined` when the path is outside them all.
 */
export function scopeOf(virtualPath) {
  // A classifier, not a gate: a path outside the tree is simply unclassified, and
  // the throwing decision belongs to `toRealPath` / `resolveRealPath`.
  if (typeof virtualPath !== 'string' || virtualPath.split('/').includes('..')) return undefined
  if (virtualPath !== MEMORY_ROOT && !virtualPath.startsWith(`${MEMORY_ROOT}/`)) return undefined
  const path = normalizePath(virtualPath)
  for (const scope of NAMED_SCOPES) {
    const prefix = `${MEMORY_ROOT}/${scope}`
    if (path === prefix || path.startsWith(`${prefix}/`)) return scope
  }
  return 'user'
}

/** Reject non-absolute and `..`-bearing paths before they reach the filesystem. */
function normalizePath(virtualPath) {
  if (typeof virtualPath !== 'string' || virtualPath === '') throw new MemoryPathError('path is required')
  if (!isAbsolute(virtualPath)) throw new MemoryPathError(`path must be absolute and start with ${MEMORY_ROOT}, got ${JSON.stringify(virtualPath)}`)
  let path = normalize(virtualPath).replace(/\\/g, '/')
  if (path !== '/' && path.endsWith('/')) path = path.slice(0, -1)
  if (path.split('/').includes('..')) throw new MemoryPathError(`path must not contain "..": ${virtualPath}`)
  if (path !== MEMORY_ROOT && !path.startsWith(`${MEMORY_ROOT}/`)) {
    throw new MemoryPathError(`path must be inside ${MEMORY_ROOT}, got ${virtualPath}`)
  }
  return path
}

/**
 * Map a virtual path to a real one by lexical means alone.
 *
 * Cheap, synchronous, and safe to call for classification. It is NOT sufficient
 * to authorise a call — {@link resolveRealPath} adds the symlink check, and that
 * is the one every tool call must go through.
 *
 * @param virtualPath - the model-supplied path.
 * @param roots - the result of {@link resolveRoots}.
 * @returns the absolute real path.
 * @throws {MemoryPathError} when the path is malformed, unscoped, or escapes
 * lexically.
 */
export function toRealPath(virtualPath, roots) {
  const path = normalizePath(virtualPath)
  const scope = scopeOf(path)
  if (scope === undefined) throw new MemoryPathError(`path is outside the memory scopes: ${virtualPath}`)
  const root = resolve(roots[scope])
  const real = resolve(root, relative(MEMORY_ROOT + (scope === 'user' ? '' : `/${scope}`), path))
  if (!isInside(root, real)) throw new MemoryPathError(`path escapes the ${scope} memory scope: ${virtualPath}`)
  return real
}

/**
 * Map a virtual path to a real one, and refuse anything that escapes its scope.
 *
 * Lexical containment is checked first because it is cheap and gives the model a
 * clear error. The real path is then checked as well, so a symlink planted
 * inside a memory directory cannot reach the rest of the disk — and that check
 * applies to reads as much as writes, because a symlink is just as good at
 * exfiltrating through `view` as at overwriting through `create`.
 *
 * One resolver serves both. A path that does not exist yet is resolved by its
 * deepest existing ancestor, so a `create` into a new directory is still proven
 * contained.
 *
 * @param virtualPath - the model-supplied path.
 * @param roots - the result of {@link resolveRoots}.
 * @returns the absolute real path.
 * @throws {MemoryPathError} when the path is malformed, unscoped, or escapes.
 */
export async function resolveRealPath(virtualPath, roots) {
  const real = toRealPath(virtualPath, roots)
  const root = resolve(roots[scopeOf(virtualPath)])
  const parts = relative(root, real).split(sep).filter(Boolean)

  // Walk down while the path exists, remembering how much of it does.
  const consumed = []
  let current = root
  for (const part of parts) {
    const next = join(current, part)
    // eslint-disable-next-line no-await-in-loop -- sequential by design
    if (await exists(next)) {
      current = next
      consumed.push(part)
    } else break
  }

  // Resolve both ends through symlinks before comparing. The root may not exist
  // on a fresh install; nothing under a directory that is not there can be a
  // symlink, so the lexical form stands.
  const resolvedRoot = (await tryRealpath(root)) ?? root
  const resolvedCurrent = (await tryRealpath(current)) ?? current
  if (!isInside(resolvedRoot, resolvedCurrent)) {
    throw new MemoryPathError(`path escapes its memory scope through a link: ${virtualPath}`)
  }
  return resolve(resolvedCurrent, ...parts.slice(consumed.length))
}

async function tryRealpath(path) {
  try {
    return await realpath(path)
  } catch {
    return undefined
  }
}

async function exists(path) {
  return (await tryRealpath(path)) !== undefined
}

/** True when `candidate` is `root` or sits beneath it. */
function isInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * The virtual form of a real path, for rendering results back to the model.
 *
 * @param realPath - a path produced by {@link toRealPath}.
 * @param roots - the result of {@link resolveRoots}.
 * @returns the `/memories/…` path, or `undefined` when it is outside every root.
 */
export function toVirtualPath(realPath, roots) {
  for (const scope of SCOPES) {
    const root = resolve(roots[scope])
    if (isInside(root, realPath)) {
      const rest = relative(root, realPath).split(sep).filter(Boolean).join('/')
      return scope === 'user' ? `${MEMORY_ROOT}/${rest}` : `${MEMORY_ROOT}/${scope}/${rest}`
    }
  }
  return undefined
}
