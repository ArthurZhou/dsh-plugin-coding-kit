/**
 * Install the `coding-kit` agent preset when this bundle is added to a profile.
 *
 * WHY A HOST-PLANE ROW. A preset is a *directory* under
 * `${DSH_HOME}/.agent-presets/<id>/`, discovered by a filesystem scan that
 * re-reads its roots on every call. There is no registry to append to, and
 * `dsh plugin add` only forwards to pnpm — for a `link:` install pnpm does not
 * run the dependency's lifecycle scripts, so a `postinstall` would never fire.
 * A composition row is the one hook that actually runs, on every boot, in the
 * profile that installed the bundle.
 *
 * This is the one host-plane row the plugin contributes, which is why
 * `cordis.patch.yml` is no longer empty. It is a bootstrap concern rather than a
 * prompt concern: it copies two text files and mounts nothing.
 *
 * NEVER OVERWRITES. The copy runs only when the preset directory is absent, so a
 * user's edits to `agent.cordis.yml` or `preset.yml` survive every subsequent
 * boot — and so do edits to the files shipped in this package, which is the same
 * behaviour a shipped preset has. Delete the directory and it is reinstalled.
 *
 * FAILS SOFT. A preset that fails to install is a missing option in a picker,
 * not a broken harness, so every error is logged and swallowed. Booting is far
 * more valuable than a duplicate `preset.yml`.
 *
 * @module dsh-plugin-coding-kit/install-preset
 */
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name, used by loader diagnostics. */
const name = 'coding-kit-preset'

/** No service dependencies: this only touches the filesystem at boot. */
const inject = []

/** The preset id, which is also the directory name. */
const PRESET_ID = 'coding-kit'

/** The files that make a directory a discoverable preset. */
const FILES = ['agent.cordis.yml', 'preset.yml']

/** The preset directory shipped inside this package. */
const SOURCE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'preset')

/**
 * The user preset root, matching the roster's own derivation.
 *
 * Read from the environment rather than `@deepseek-ai/dsh-home-paths`, for the
 * same reason `memory/paths.js` reads `$DSH_HOME` directly: a `link:`-installed
 * plugin cannot resolve host packages.
 *
 * @returns the absolute preset root.
 */
export function presetRoot() {
  const home = process.env.DSH_HOME
  return join(home !== undefined && home !== '' ? home : join(homedir(), '.dsh'), '.agent-presets')
}

/**
 * Install the preset if it is not already there.
 *
 * `config` is defaulted because the composition row carries no `config:` block:
 * a plugin without a `Config` schema is handed the raw row value, which is
 * `undefined` rather than `{}`. Reading `config.id` unguarded fails the whole
 * host boot with `Cannot read properties of undefined`.
 *
 * @param ctx - the plugin context.
 * @param config - optional `overwrite`, off by default, and `id`.
 * @returns the installed directory, or `undefined` when nothing was written.
 */
function apply(ctx, config = {}) {
  void ctx
  const id = config.id ?? PRESET_ID
  const target = join(presetRoot(), id)
  return install(id, target, config.overwrite === true)
}

/**
 * Copy the preset into place, never clobbering an existing one.
 *
 * @param id - the preset id.
 * @param target - the absolute destination directory.
 * @param overwrite - replace existing files instead of skipping them.
 * @returns the installed directory, or `undefined` when nothing was written.
 */
async function install(id, target, overwrite) {
  try {
    if (!overwrite) {
      // One existing file is enough to claim the id: a half-copied preset from
      // an interrupted boot is better finished than restarted.
      const existing = await Promise.all(FILES.map((file) => exists(join(target, file))))
      if (existing.every(Boolean)) return undefined
    }
    await mkdir(target, { recursive: true })
    for (const file of FILES) {
      if (!overwrite && (await exists(join(target, file)))) continue
      await copyFile(join(SOURCE_DIR, file), join(target, file))
    }
    console.log(`coding-kit: installed the '${id}' agent preset at ${target}`)
    return target
  } catch (error) {
    console.error(`coding-kit: could not install the '${id}' agent preset at ${target}:`, error)
    return undefined
  }
}

async function exists(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export { FILES, PRESET_ID, SOURCE_DIR, apply, inject, install, name }
