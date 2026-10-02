import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { compositionPaths, projectLane, seedIntent, normalizeIntent } from './lane-projection.mjs'

/**
 * The host half: the cheap lane's settings, and their projection into the agent
 * compositions that register the lane.
 *
 * WHY A HOST ROW AT ALL. `agent.cordis.yml` is the only editor of an agent
 * composition — the preset roster documents that files are the only composition
 * editor, and it is right: the composition decides which tools exist, so it has
 * to be reconstructable from a file. But a browser cannot write a file: the
 * stock wire exposes `settings` (settings documents), and a custom Typert
 * domain would need generated codecs. So the INTENT lives in a settings
 * namespace, which the wire can reach and the built-in settings surface already
 * knows how to render, and this row pushes the resolved value into every
 * composition carrying a `tool-subagent-cheap` row.
 *
 * The direction is one-way by construction. The namespace is the intent, the
 * composition is the projection, and the only read that goes the other way is
 * the one-time seed below, which runs while the user section is still empty.
 *
 * The namespace name is written as a bare string rather than through
 * `settingsNamespace()`: that helper is a pattern check returning its argument,
 * and this file stays free of host-package imports so the row cannot fail to
 * load on a deployment that resolves dependencies differently.
 *
 * @module dsh-plugin-coding-kit/host
 */

/** Cordis plugin name, used by loader diagnostics. */
const name = 'coding-kit-lane'

/** The settings registry, and nothing else: this row writes no tools. */
const inject = ['settings']

/** Settings namespace carrying the lane's intent. */
const NAMESPACE = 'cheap-lane'

/** The user-writable slice. Defaults mirror the shipped composition row. */
const LaneSchema = z.object({
  /** Provider route the lane's child runs on (`llm-pi-ai.providers.<name>`). */
  modelProvider: z.string().default(''),
  /** Model id interpreted by that provider's adapter. */
  model: z.string().default(''),
  /** Output-token cap per child request. */
  maxTokens: z.number().step(1).min(1).default(16384),
  /** Tools the child may call. An empty list is refused, not applied. */
  allow: z.array(z.string()).default(['read', 'glob', 'grep', 'bash']),
})

/** Runtime schema for the row. */
const Config = z.object({
  /**
   * Preset roots to project into. Defaults to `$DSH_HOME/.agent-presets`, which
   * is where the installer puts `coding-kit` and where every user preset lives.
   */
  presetRoots: z.array(z.string()).default([]),
  /** Whether to push the namespace into the compositions at all. */
  sync: z.boolean().default(true),
  /**
   * Copy the namespace into settings.yaml on first boot, from the row the
   * compositions already carry. Only while the user section is empty, so this
   * never overwrites a choice made through the UI.
   */
  seed: z.boolean().default(true),
  /** Base values for the namespace — this row's own defaults. */
  lane: LaneSchema,
})

const harnessHome = () => process.env.DSH_HOME ?? join(homedir(), '.dsh')

/**
 * Register the namespace and keep the compositions in step with it.
 *
 * Nothing here throws. A host row that rejects takes the whole boot down, and
 * every failure this can hit is a lane that does not get re-pointed — one
 * preset keeps the values it shipped with, which is a working lane, not a
 * broken harness.
 *
 * @param ctx - the host plugin context.
 * @param config - preset roots, sync policy, and the namespace's base values.
 */
function apply(ctx, config) {
  const roots = config.presetRoots.length === 0 ? [join(harnessHome(), '.agent-presets')] : config.presetRoots
  const scope = ctx.settings.register(NAMESPACE, LaneSchema, { base: config.lane })

  const project = async (intent, reason) => {
    const paths = await compositionPaths(roots)
    const result = await projectLane(paths.map((entry) => entry.path), intent)
    for (const applied of result.applied) {
      ctx.logger.info(`cheap-lane: ${reason} → ${applied.path} now runs ${applied.model} (maxTokens ${applied.maxTokens}, allow [${applied.allow.join(', ')}])`)
    }
    for (const failure of result.failed) ctx.logger.warn(`cheap-lane: ${reason} could not update ${failure.path}: ${failure.error}`)
    // Three outcomes, three messages. Collapsing "already in effect" into "no
    // lane row" would make a healthy boot look like a misconfiguration, and the
    // operator would go looking for a preset that is right there.
    if (result.applied.length === 0 && result.failed.length === 0) {
      if (result.skipped.length > 0) ctx.logger.info(`cheap-lane: ${reason} — already in effect in ${result.skipped.length} composition(s)`)
      else ctx.logger.warn(`cheap-lane: none of the ${paths.length} compositions under ${roots.join(', ')} carries a tool-subagent-cheap row, so ${reason} changed nothing`)
    }
    return result
  }

  if (!config.sync) return

  ctx.effect(() => {
    let ready = false
    let projected = ''

    const sync = async (reason) => {
      try {
        let intent
        try {
          intent = normalizeIntent(scope.get())
        } catch (error) {
          ctx.logger.warn(`cheap-lane: the namespace holds an unusable value, leaving the compositions alone: ${String(error?.message ?? error)}`)
          return
        }
        // Deep-equal guard: a settings commit that did not move the intent must
        // not rewrite files, and the seed below writes the same values back.
        const fingerprint = JSON.stringify(intent)
        if (fingerprint === projected) return
        await project(intent, reason)
        projected = fingerprint
      } catch (error) {
        ctx.logger.warn(`cheap-lane: projection failed: ${String(error?.message ?? error)}`)
      }
    }

    scope.watch((next) => {
      if (!ready) return
      sync('settings change')
    })

    const boot = async () => {
      if (config.seed) {
        try {
          const described = await ctx.settings.describe({ redactSecrets: true })
          const view = (described?.namespaces ?? []).find((entry) => entry.ns === NAMESPACE)
          const untouched = view === undefined || Object.keys(view.user ?? {}).length === 0
          if (untouched) {
            const paths = await compositionPaths(roots)
            const seeded = await seedIntent(paths.map((entry) => entry.path))
            if (seeded !== undefined && (seeded.model !== '' || seeded.modelProvider !== '')) {
              await scope.update(seeded)
              ctx.logger.info(`cheap-lane: seeded the ${NAMESPACE} namespace from the shipped composition (${seeded.modelProvider}/${seeded.model})`)
            }
          }
        } catch (error) {
          ctx.logger.warn(`cheap-lane: seeding skipped: ${String(error?.message ?? error)}`)
        }
      }
      ready = true
      await sync('boot')
    }

    boot().catch((error) => ctx.logger.warn(`cheap-lane: boot sync failed: ${String(error?.message ?? error)}`))
  }, 'codingKit.lane()')
}

export { Config, NAMESPACE, LaneSchema, apply, inject, name }
