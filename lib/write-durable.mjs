/**
 * The two things every write of a config file must do, in this order.
 *
 * `writeDurable` backs up, writes atomically, and proves the file still parses.
 * The backup is timestamped and never overwritten, so the history is a
 * directory listing rather than a single slot that the next write silently
 * replaces. The proof runs twice — once on the text before it is allowed to
 * land, once on the bytes read back after — because the second is the only
 * place a claim about the result is true.
 *
 * @module dsh-plugin-coding-kit/write-durable
 */

import { readFile, writeFile, rename, copyFile } from 'node:fs/promises'

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

/**
 * Replace `path` with `text`, keeping a timestamped copy of what was there.
 *
 * @param {string} path - the file to replace.
 * @param {string} text - its new contents.
 * @param {object} [options]
 * @param {(text: string) => unknown} [options.validate] - rejects the text before it lands.
 * @param {(text: string) => unknown} [options.verify] - runs on the bytes read back after the rename.
 * @returns {Promise<{ backup: string, verified: unknown }>}
 */
export async function writeDurable(path, text, { validate, verify } = {}) {
  await copyFile(path, `${path}.bak-${stamp()}`)
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, text)
  try {
    if (validate !== undefined) validate(text)
  } catch (error) {
    throw new Error(`refusing to write ${path}: ${String(error?.message ?? error)}`)
  }
  await rename(tmp, path)
  const landed = await readFile(path, 'utf8')
  if (verify !== undefined) {
    try {
      return { backup: `${path}.bak`, verified: await verify(landed) }
    } catch (error) {
      throw new Error(`wrote ${path} but the result does not verify: ${String(error?.message ?? error)}`)
    }
  }
  return { backup: `${path}.bak`, verified: undefined }
}
