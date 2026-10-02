/**
 * Projecting the cheap lane's settings into the agent compositions that
 * actually register the tool.
 *
 * WHY A PROJECTION AND NOT A DIRECT EDIT. `agent.cordis.yml` is the only
 * editor of an agent composition — the preset roster documents that files are
 * the only composition editor, and it is right: the composition decides which
 * tools and prompt sections exist, so it has to be reconstructable from a file.
 * A web UI cannot call "write this file": the stock wire exposes `settings`
 * (settings documents), and a custom Typert domain needs generated codecs. So
 * the intent lives where the wire can reach it — the `cheap-lane` settings
 * namespace — and this module pushes the resolved value into every composition
 * that carries a `tool-subagent-cheap` row.
 *
 * The direction matters and is one-way by construction: the namespace is the
 * intent, the composition is the projection, and nothing reads the composition
 * back into the namespace except the one-time seed in the host half, which runs
 * only while the user section is still empty.
 *
 * Every write goes through `writeDurable` (backup, atomic rename, verify) and
 * through the line editor, so the comments that explain each row survive.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { readLane, patchLane } from './preset-edit.mjs'
import { writeDurable } from './write-durable.mjs'

/** Composition row that registers the lane. */
export const LANE_ROW = 'tool-subagent-cheap'

/** Shape the settings namespace holds. Kept as a plain shape, not a schema. */
export function normalizeIntent(intent) {
  const allow = (intent.allow ?? []).map((tool) => String(tool).trim()).filter(Boolean)
  if (allow.length === 0) throw new Error('the lane needs at least one tool in its allow-list, or the child has none at all')
  const maxTokens = Number(intent.maxTokens)
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error(`maxTokens must be a positive whole number, got ${JSON.stringify(intent.maxTokens)}`)
  const modelProvider = String(intent.modelProvider ?? '').trim()
  const model = String(intent.model ?? '').trim()
  if (model === '') throw new Error('the lane needs a model id: without one the child inherits this session\'s model and the lane saves nothing')
  if (modelProvider === '') throw new Error('the lane needs a provider route; the model id is interpreted by that provider, not by the default one')
  return { modelProvider, model, maxTokens, allow }
}

/** The intent a given composition row already encodes, as a settings value. */
export function intentFromLane(lane) {
  return { modelProvider: lane.modelProvider, model: lane.model, maxTokens: lane.maxTokens, allow: lane.allow }
}

/** Whether a settings section differs from a lane in anything worth writing. */
export function laneMatchesIntent(lane, intent) {
  const want = normalizeIntent(intent)
  return lane.modelProvider === want.modelProvider
    && lane.model === want.model
    && lane.maxTokens === want.maxTokens
    && lane.allow.join(',') === want.allow.join(',')
}

/** Composition files under a preset root, in directory order. */
export async function compositionPaths(presetRoots) {
  const { readdir } = await import('node:fs/promises')
  const out = []
  for (const root of presetRoots) {
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue
      const path = join(root, entry.name, 'agent.cordis.yml')
      try {
        await readFile(path, 'utf8')
      } catch {
        continue
      }
      out.push({ id: entry.name, path })
    }
  }
  return out
}

/**
 * Read every composition that registers the lane.
 *
 * A composition WITHOUT the row is not an error and not a warning-worthy
 * surprise: most presets ship no lane at all, and inventing one would put a
 * subagent in front of a prompt that never mentions it.
 *
 * @param {string[]} paths - composition files to read.
 * @returns {Promise<Array<{ path: string, lane: object, text: string }>>}
 */
export async function readLanes(paths) {
  const found = []
  for (const path of paths) {
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch {
      continue
    }
    try {
      found.push({ path, lane: readLane(text, LANE_ROW), text })
    } catch {}
  }
  return found
}

/**
 * Write the intent into every composition that carries a lane row.
 *
 * One composition failing does not stop the others: a partial sync is reported,
 * never silent, and each write verifies itself before it lands.
 *
 * @param {string[]} paths - candidate composition files.
 * @param {object} intent - the resolved `cheap-lane` namespace value.
 * @returns {Promise<{ applied: object[], skipped: object[], failed: object[] }>}
 */
export async function projectLane(paths, intent) {
  const want = normalizeIntent(intent)
  const applied = []
  const skipped = []
  const failed = []
  for (const { path, lane } of await readLanes(paths)) {
    if (laneMatchesIntent(lane, want)) {
      skipped.push({ path, reason: 'already matches' })
      continue
    }
    try {
      const text = await readFile(path, 'utf8')
      const patched = patchLane(text, want, LANE_ROW)
      await writeDurable(path, patched.text, {
        validate: (candidate) => readLane(candidate, LANE_ROW),
        verify: async (landed) => {
          const read = readLane(landed, LANE_ROW)
          if (!laneMatchesIntent(read, want)) throw new Error(`the row reads back as ${read.modelProvider}/${read.model}`)
          return read
        },
      })
      applied.push({ path, model: `${want.modelProvider}/${want.model}`, maxTokens: want.maxTokens, allow: want.allow })
    } catch (error) {
      failed.push({ path, error: String(error?.message ?? error) })
    }
  }
  return { applied, skipped, failed }
}

/**
 * The intent to seed a fresh namespace with: the first composition that carries
 * a lane row. Later rows are left alone — a disagreement between two presets is
 * the operator's to resolve, not something a boot should paper over by picking
 * whichever sorted first.
 *
 * @param {string[]} paths - candidate composition files.
 * @returns {Promise<object | undefined>}
 */
export async function seedIntent(paths) {
  const lanes = await readLanes(paths)
  const first = lanes[0]
  return first === undefined ? undefined : intentFromLane(first.lane)
}
