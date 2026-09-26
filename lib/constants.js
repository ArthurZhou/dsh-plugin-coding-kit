/**
 * The two prompt-registry slots this plugin shadows.
 *
 * These are duplicated here rather than imported from
 * `@deepseek-ai/dsh-system-prompt` on purpose. A dsh plugin installed with
 * `dsh plugin add <path>` is linked into the profile, so its modules resolve
 * from the *real* checkout directory, not from the profile — and a bare import
 * of a host package would then depend on hoisting that a `link:` install does
 * not perform. Two string constants are a cheaper thing to keep honest than a
 * resolution failure at agent-creation time.
 *
 * Provenance, and how to re-verify after a DSH upgrade: both values are
 * exported by the host package and documented as the composition seam. A
 * composition replaces a slot by re-using its name in the nearest scope layer,
 * so the names below must match the registry's exactly:
 *
 *   - `dsh-system-prompt` registers the identity opener in its constructor,
 *     unconditionally, in the GLOBAL layer.
 *   - `dsh-system-prompt` registers `config.persona` as `PERSONA_SECTION` at
 *     `PERSONA_ORDER`, also in the global layer.
 *   - `dsh-persona` registers the same persona slot into the CALLING context's
 *     layer, which is the whole reason a preset can shadow it.
 *
 * `test/prompt-shadow.test.mjs` re-checks both against the installed host
 * package whenever it happens to be resolvable, so a rename upstream shows up
 * as a failing test rather than a silently dead shadow.
 *
 * @module dsh-plugin-coding-kit/constants
 */

/**
 * The deployment persona's section name. Shadowing this replaces the
 * deployment's `persona:` config AND any persona an enclosing preset already
 * registered, because the nearest layer wins.
 */
const PERSONA_SECTION = 'deployment:persona'

/** Prompt order of the persona slot; the first section a model reads. */
const PERSONA_ORDER = 0

/**
 * The harness identity opener's section name. There is no exported constant
 * for it upstream — the service inlines the name and the order in its
 * constructor — so this is the value to re-check on upgrade.
 */
const IDENTITY_SECTION = 'harness:identity'

/**
 * The identity opener's order. It renders before the persona, so the opener is
 * the first line of the system message; the shadow must not reorder itself
 * even though its text is empty, and `section()` rejects a non-finite order.
 */
const IDENTITY_ORDER = -100

export { IDENTITY_ORDER, IDENTITY_SECTION, PERSONA_ORDER, PERSONA_SECTION }
