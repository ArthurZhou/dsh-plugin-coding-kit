import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AnonymousEntries, NamedEntries, ScopedLayers, createScope } from '@deepseek-ai/dsh-scope'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { Context } from '@deepseek-ai/cordis'
import { IDENTITY_ORDER, IDENTITY_SECTION, PERSONA_ORDER, PERSONA_SECTION } from '../lib/constants.js'
import { PERSONA } from '../lib/persona.js'

/**
 * The plugin's own unit tests stub the prompt registry. This file instead uses
 * the real registry primitives — `ScopedLayers` for the layer merge and
 * `renderPrompt` for the final text — because the plugin's correctness rests on
 * two upstream behaviours that a stub cannot check:
 *
 *   1. a scoped section shadows a same-named global section, nearest wins;
 *   2. `renderPrompt()` drops a section whose interpolated text is empty.
 *
 * Together they are what makes an empty `harness:identity` shadow remove the
 * identity opener rather than print a blank line, and what makes a scoped
 * `deployment:persona` replace the deployment persona instead of stacking a
 * second one after it.
 *
 * Both are asserted here against a layer set shaped like the one
 * `dsh-system-prompt` builds, containing the real sections a session would
 * have: the identity opener, the persona, `plan:policy`, and two `tool:*`
 * guardrails.
 */
function layer() {
  return {
    sections: new NamedEntries(() => new Error('duplicate section')),
    contexts: new NamedEntries(() => new Error('duplicate context')),
    variables: new NamedEntries(() => new Error('duplicate variable')),
    toolProviders: new AnonymousEntries(),
    runtimeContextSuppressors: new AnonymousEntries(),
    isEmpty() {
      return this.sections.isEmpty() && this.contexts.isEmpty() && this.variables.isEmpty()
    },
  }
}

/**
 * The opener `dsh-system-prompt` registers in its constructor, verbatim. Kept as
 * one constant so the fixture and the assertion that it disappears cannot drift.
 */
const HARNESS_IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'

/** The section set `dsh-system-prompt` + the tool plugins register globally. */
const GLOBAL = [
  { name: IDENTITY_SECTION, order: IDENTITY_ORDER, text: HARNESS_IDENTITY },
  { name: PERSONA_SECTION, order: PERSONA_ORDER, text: 'You are a coding agent powered by the deepseek model.' },
  { name: 'plan:policy', order: 50, text: 'You are in plan mode.' },
  { name: 'tool:read', order: 100, text: 'Use the read tool — not shell commands like cat.' },
  { name: 'tool:bash', order: 105, text: 'Check the [exit code: N] marker on every bash result.' },
]

/** Exactly what `dsh-plugin-coding-kit` registers in a preset's layer. */
const PERSONA_SECTION_TEXT = [
  { name: PERSONA_SECTION, order: PERSONA_ORDER, text: PERSONA },
  { name: IDENTITY_SECTION, order: IDENTITY_ORDER, text: '' },
]

/**
 * Assemble the prompt the way `SystemPrompt.assemble()` does: merge the global
 * layer with the scope chain, sort by order, and render. The scope chain is a
 * real one — an agent scope parented to a preset scope, which is exactly the
 * shape `dsh-agent-presets` creates when a session joins a preset.
 */
function assemble(sections) {
  const root = new Context()
  const layers = new ScopedLayers(layer, () => {})
  for (const section of sections) layers.global.sections.insert(section.name, section)

  // Scope keys are opaque objects: `dsh-scope` records the parent chain in a
  // WeakMap, so a string key is rejected outright.
  const presetKey = {}
  const agentKey = {}
  const preset = createScope(root, presetKey)
  const agent = createScope(root, agentKey, { parent: presetKey })
  try {
    const scoped = layer()
    for (const section of PERSONA_SECTION_TEXT) scoped.sections.insert(section.name, section)
    layers.scoped.set(presetKey, scoped)

    return renderPrompt({
      sections: [...layers.merge(agentKey, l => l.sections).values()].sort((a, b) => a.order - b.order),
      variables: { model: 'deepseek-v4-flash', cwd: '/home/az/project', provider: 'deepseek-official' },
    })
  } finally {
    agent.dispose()
    preset.dispose()
  }
}

/** The persona as `renderPrompt` emits it, with the test's variables filled in. */
const RENDERED = PERSONA
  .replaceAll('{{model}}', 'deepseek-v4-flash')
  .replaceAll('{{cwd}}', '/home/az/project')

test('a scoped persona shadows the deployment persona instead of stacking', () => {
  const prompt = assemble(GLOBAL)
  // The deployment persona must be gone, not sitting after the new one.
  assert.ok(!prompt.includes('You are a coding agent powered by the deepseek model.'))
  assert.ok(prompt.includes(RENDERED))
})

test('an empty identity shadow removes the harness identity opener', () => {
  const prompt = assemble(GLOBAL)
  // Assert on the opener's exact sentence, not on the substring "DeepSeek
  // Harness": the persona is free to name the harness itself, and this test must
  // keep passing when it does.
  assert.ok(!prompt.includes(HARNESS_IDENTITY), 'the identity opener is still present')
  assert.ok(!prompt.startsWith(HARNESS_IDENTITY), 'the identity opener is still first')
})

test('the tool guardrail sections and plan mode survive the swap', () => {
  const prompt = assemble(GLOBAL)
  assert.ok(prompt.includes('You are in plan mode.'), 'plan:policy was dropped')
  assert.ok(prompt.includes('Use the read tool'), 'tool:read was dropped')
  assert.ok(prompt.includes('[exit code: N]'), 'tool:bash was dropped')
})

test('the interpolated prompt opens with the persona', () => {
  const prompt = assemble(GLOBAL)
  assert.ok(
    prompt.startsWith(RENDERED.split('\n')[0]),
    `prompt did not open with the persona: ${JSON.stringify(prompt.slice(0, 80))}`,
  )
  assert.ok(prompt.includes('Your working directory is /home/az/project.'))
})

test('the persona renders first, before the surviving sections', () => {
  const prompt = assemble(GLOBAL)
  assert.ok(prompt.indexOf(RENDERED) < prompt.indexOf('You are in plan mode.'))
  assert.ok(prompt.indexOf('You are in plan mode.') < prompt.indexOf('Use the read tool'))
})
