import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config, apply } from '../lib/index.js'
import { IDENTITY_ORDER, IDENTITY_SECTION, PERSONA_ORDER, PERSONA_SECTION } from '../lib/constants.js'
import { PERSONA } from '../lib/persona.js'

/**
 * A stand-in for the registries `apply` touches: `systemPrompt` and `tools`.
 * The real `section()` files the registration into the calling context's scope
 * layer and returns a disposer; recording the section and handing back a
 * disposer is enough to assert the plugin's contract without standing up a
 * Cordis tree. `tools` is stubbed because the memory half of the plugin
 * registers a tool there, and that must not reach the real registry in a unit
 * test.
 */
function harness(config = {}) {
  const sections = []
  const tools = []
  const disposers = []
  const ctx = {
    systemPrompt: {
      section(section) {
        sections.push(section)
        return { dispose: () => sections.splice(sections.indexOf(section), 1) }
      },
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return { dispose: () => tools.splice(tools.indexOf(definition), 1) }
      },
    },
    effect(effect, label) {
      const disposer = effect()
      disposers.push({ label, disposer })
      return disposer
    },
  }
  // Cordis unwraps the standard-schema result before calling `apply`; do the
  // same here so the test exercises the same config object shape.
  const result = Config['~standard'].validate(config)
  assert.equal(result.issues, undefined, `config did not validate: ${JSON.stringify(result.issues)}`)
  apply(ctx, result.value)
  const find = (name) => sections.find((section) => section.name === name)
  return { sections, tools, disposers, find }
}

test('replaces the deployment persona slot, keeping its name and order', () => {
  const { find } = harness()
  const persona = find(PERSONA_SECTION)
  assert.ok(persona, 'the persona slot must be shadowed, not appended beside it')
  assert.equal(persona.order, PERSONA_ORDER)
  assert.equal(persona.text, PERSONA)
})

test('a custom text replaces the bundled persona', () => {
  const { find } = harness({ text: 'mine' })
  assert.equal(find(PERSONA_SECTION).text, 'mine')
})

test('never marks the persona complete, so tool and plan-mode sections survive', () => {
  const { find } = harness()
  // `complete: true` would make this the only system section, dropping
  // `plan:policy` and every `tool:*` guardrail along with it.
  assert.equal(find(PERSONA_SECTION).complete, undefined)
})

test('shadows the harness identity opener with empty text', () => {
  const { find } = harness()
  const identity = find(IDENTITY_SECTION)
  assert.ok(identity, 'the identity opener must be shadowed')
  // `renderPrompt()` drops any section whose interpolated text is empty, so
  // this contributes no prompt at all.
  assert.equal(identity.text, '')
  assert.equal(identity.order, IDENTITY_ORDER)
})

test('includeHarnessIdentity keeps the opener and registers no shadow for it', () => {
  const { find } = harness({ includeHarnessIdentity: true })
  assert.equal(find(IDENTITY_SECTION), undefined)
  // The persona is still replaced — that half is independent of the opener.
  assert.equal(find(PERSONA_SECTION).text, PERSONA)
})

test('the memory halves are registered by default and can be turned off', () => {
  const on = harness()
  assert.deepEqual(
    on.tools.map((tool) => tool.name),
    ['memory'],
  )
  for (const name of ['memory:user', 'memory:index']) {
    assert.ok(on.find(name), `${name} is not registered`)
  }

  const off = harness({ memory: false })
  assert.deepEqual(off.tools, [])
  assert.equal(off.find('memory:user'), undefined)
  assert.equal(off.find('memory:index'), undefined)
})

test('every registration is owned by the context and unwinds with it', () => {
  const { disposers, sections, tools } = harness()
  assert.deepEqual(
    disposers.map(({ label }) => label),
    ['codingKit.identity()', 'codingKit.persona()', 'codingKit.memoryTool()', 'codingKit.userMemory()', 'codingKit.memoryIndex()'],
  )
  for (const { disposer } of disposers) disposer.dispose()
  assert.deepEqual(sections, [])
  assert.deepEqual(tools, [], 'the memory tool outlived the context')
})

test('the bundled persona only references registered prompt variables', () => {
  // `dsh-agent-loop` registers exactly provider/model/cwd; an unknown or
  // undefined variable makes `renderPrompt()` throw mid-request.
  const used = [...PERSONA.matchAll(/\{\{([^{}]*)\}\}/g)].map((match) => match[1])
  for (const variable of used) {
    assert.match(variable, /^[a-z][a-z0-9_]*$/, `"{{${variable}}}" is not a valid variable name`)
    assert.ok(
      ['provider', 'model', 'cwd'].includes(variable),
      `"{{${variable}}}" is not a registered prompt variable`,
    )
  }
})

test('the persona text carries no stray interpolation', () => {
  // Replays `interpolate()`'s scan. A `{{` that does not immediately close
  // into `[^{}]*}}` is a malformed reference — and if a later `}}` exists
  // anywhere, the real renderer throws mid-request, because it cannot tell a
  // malformed reference from a real one. Substituted values are not rescanned,
  // so only the literal text has to be clean.
  const GROUP = /^\{\{([^{}]*)\}\}/
  let last = 0
  for (let open = PERSONA.indexOf('{{'); open >= 0; open = PERSONA.indexOf('{{', last)) {
    const at = `…${PERSONA.slice(Math.max(0, open - 24), open + 24)}…`
    assert.ok(GROUP.test(PERSONA.slice(open)), `malformed prompt variable reference at ${at}`)
    last = open + GROUP.exec(PERSONA.slice(open))[0].length
  }
})

test('the shadowed slot names still match the installed host package', async (t) => {
  // The constants are duplicated rather than imported (see lib/constants.js),
  // so a rename upstream has to be caught here. Skipped when the host package
  // is not resolvable — the plugin itself must not depend on it.
  let host
  try {
    host = await import('@deepseek-ai/dsh-system-prompt')
  } catch {
    t.skip('@deepseek-ai/dsh-system-prompt is not resolvable from here')
    return
  }
  assert.equal(PERSONA_SECTION, host.PERSONA_SECTION, 'the persona slot name moved')
  assert.equal(PERSONA_ORDER, host.PERSONA_ORDER, 'the persona slot order moved')
  // Upstream exports no identity constant, so assert on the value the service
  // itself registers instead.
  const source = await import('node:fs').then(fs => fs.readFileSync(new URL(import.meta.resolve('@deepseek-ai/dsh-system-prompt')), 'utf8'))
  assert.match(source, /name: "harness:identity"/, 'the identity opener section name moved')
  assert.match(source, /order: -100/, 'the identity opener section order moved')
})
