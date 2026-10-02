import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PERSONA } from '../lib/persona.js'

/**
 * The register rule: rigorous, compact, exact — and the two things it must not
 * break.
 *
 * The failure this pins is quiet in both directions. Dropped, the prompt goes
 * back to hedged, padded prose that reads as thoroughness. Over-applied, it
 * starts trimming the hedging the same prompt requires ("if you are unsure, say
 * so") and the model stops admitting what it has not checked — which is the one
 * failure worse than a verbose answer. Both are prompt-level regressions that no
 * tool call and no test elsewhere would catch.
 */

const section = PERSONA.slice(PERSONA.indexOf('## Say it plainly'), PERSONA.indexOf('## Work that outlives'))

test('the register rule exists and is not a paragraph of taste', () => {
  assert.ok(section.length > 0, 'the register rule is gone from the persona')
  for (const banned of ['Colloquial filler', 'Empty contrast', 'Intensifiers', 'restated']) {
    assert.ok(section.includes(banned), `no rule against ${banned}`)
  }
})

test('each banned construction carries the test that catches it mechanically', () => {
  // A rule satisfiable only by taste is satisfied inconsistently.
  assert.match(section, /incident report/, 'the colloquial ban has no mechanical test')
  assert.match(section, /delete the whole clause/, 'the contrast ban has no mechanical test')
  assert.match(section, /if the sentence weakens/, 'the intensifier ban has no mechanical test')
})

test('the ban names the constructions in both languages the user writes in', () => {
  assert.ok(section.includes('不是'), 'the empty-contrast ban does not name the Chinese form')
  assert.ok(section.includes('与其说'), 'the empty-contrast ban does not name 与其说…不如说')
  assert.ok(section.includes('搞定了'), 'the colloquial ban does not name a Chinese example')
  assert.ok(section.includes('basically'), 'the colloquial ban does not name an English example')
})

test('precision is fenced off from brevity', () => {
  // These two carve-outs keep the rule from eating the honesty rules.
  assert.match(section, /Uncertainty that carries information stays/, 'the rule would trim honest uncertainty')
  assert.match(section, /plain is not blunt/, 'the rule would reward vagueness as brevity')
  assert.ok(PERSONA.includes('If you are unsure, say so'), 'the honesty rule is gone; the carve-out would be moot')
})

test('the rule sits early and is re-checked at reply time', () => {
  // Governs every sentence, so it cannot live only at either end.
  const style = PERSONA.indexOf('## Say it plainly')
  const gate = PERSONA.indexOf('## Before you send the reply')
  assert.ok(style > 0 && style < PERSONA.length / 2, 'the register rule must sit in the first half, where attention is not yet spent')
  assert.ok(gate > style, 'the reply-time check must follow the policy it checks')
  assert.match(PERSONA.slice(gate), /5\. Register:/, 'the pre-reply gate does not check the register')
  assert.match(PERSONA.slice(gate), /five checks/, 'the gate still claims to be four checks')
})
