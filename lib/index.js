import z from '@deepseek-ai/schemastery'
import { IDENTITY_ORDER, IDENTITY_SECTION, PERSONA_ORDER, PERSONA_SECTION } from './constants.js'
import { PERSONA } from './persona.js'
import { apply as memoryApply } from './memory.js'

/**
 * Replace the harness's own prompt text, without touching anything else the
 * agent sees.
 *
 * DSH assembles each model request from three independent channels:
 *
 *   1. **Prompt sections** → joined by `renderPrompt()` into the single system
 *      message. This plugin rewrites two of them and none of the others.
 *   2. **Tool schemas** → passed to the provider as native function-calling
 *      tools. Nothing here is on that path, so every tool, and every tool's
 *      own guardrail section (`tool:read`, `tool:bash`, `tool:web_search`, …),
 *      is preserved exactly as the harness registered it.
 *   3. **Runtime context** (cwd, clock, terminal) → prepended as a user
 *      message by `dsh-agent-loop`, not as a system section. Also untouched.
 *
 * Both rewrites are *scoped* registrations. `dsh-scope`'s layer chain resolves
 * an agent's view as `agent → preset → global`, nearest shadowing farthest, so
 * a section registered here shadows the same-named global section for agents
 * mounted under this preset and for nothing else.
 *
 * Shadowing with empty text is what removes a section rather than replacing it:
 * `renderPrompt()` drops any section whose interpolated text is empty, so an
 * empty shadow contributes no prompt at all. It is the agent-plane counterpart
 * of the host-plane `includeHarnessIdentity: false` service config, which this
 * plugin deliberately does not use — that one is global by construction.
 *
 * `persona.complete` is intentionally NOT set. Setting it would make this
 * section the *sole* system section, which is a strictly larger change than
 * swapping the prompt text: it would also drop `plan:policy` (order 50) and
 * every `tool:*` guardrail, silently disabling plan mode.
 *
 * The row also contributes the memory system — a `memory` tool over three durable
 * scopes plus the prompt sections that teach and index it — because DSH has no
 * equivalent. See `./memory.js` for the trust boundary that entails.
 *
 * @module dsh-plugin-coding-kit
 */

/** Cordis plugin name, used by loader diagnostics. */
const name = 'coding-kit'

/** The prompt registry and the tool registry this row contributes to. */
const inject = ['systemPrompt', 'tools']

/** Runtime schema for the row. */
const Config = z.object({
  /**
   * The persona text, used verbatim. Only `{{provider}}`, `{{model}}`, and
   * `{{cwd}}` are registered variables; any other `{{name}}` makes assembly
   * throw. Multi-line YAML block scalars are the comfortable way to write it.
   */
  text: z.string().default(PERSONA),
  /**
   * Whether to keep the harness identity opener. `false` (the default) shadows
   * `harness:identity` with empty text so the agent's system message starts at
   * this persona instead of "You are an AI agent powered by DeepSeek Harness."
   * Set `true` to keep the opener — useful for A/B comparison, since it is then
   * the only difference between the two configurations.
   */
  includeHarnessIdentity: z.boolean().default(false),
  /**
   * Register the memory system: the `memory` tool over the user, session and
   * repository scopes, plus the prompt sections that teach and index it. Set
   * `false` to ship the persona alone — the prompt then references a capability
   * that is not in the catalog, so turn it off only together with editing the
   * `<memoryInstructions>` text out of `text`.
   */
  memory: z.boolean().default(true),
  /**
   * How many lines of user memory are auto-loaded into the system message, the
   * same budget the `<memoryInstructions>` text states. Every top-level `.md`
   * file in the user scope is eligible, in filename order.
   */
  autoLoadLines: z.number().min(0).default(200),
  /** Largest single file the `view` command returns. */
  maxViewBytes: z.number().min(0).default(50_000),
  /** Largest `file_text` the `create` command accepts. */
  maxWriteBytes: z.number().min(0).default(200_000),
  /** Largest directory walk the memory index performs per scope. */
  maxListEntries: z.number().min(0).default(200),
})

/**
 * Register the persona shadows and, unless disabled, the memory system.
 *
 * @param ctx - an agent scope context. An unscoped context would collide with
 * the prompt registry's own global registrations and reject.
 * @param config - the persona text, identity-opener policy, and memory settings.
 */
function apply(ctx, config) {
  if (!config.includeHarnessIdentity) {
    ctx.effect(
      () => ctx.systemPrompt.section({
        name: IDENTITY_SECTION,
        order: IDENTITY_ORDER,
        text: '',
      }),
      'codingKit.identity()',
    )
  }

  ctx.effect(
    () => ctx.systemPrompt.section({
      name: PERSONA_SECTION,
      order: PERSONA_ORDER,
      text: config.text,
    }),
    'codingKit.persona()',
  )

  memoryApply(ctx, config)
}

export { Config, apply, inject, name }
