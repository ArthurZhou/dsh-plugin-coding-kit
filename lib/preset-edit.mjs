/**
 * Line-structural editing of a composition file.
 *
 * WHY NOT THE YAML PARSER. `agent.cordis.yml` carries the reasoning behind every
 * row in comments, and two `!!js process.platform` expressions a parser would
 * either mangle or reject. Round-tripping it would delete the documentation it
 * exists to carry, so this editor never parses the file: it finds one row, then
 * replaces single key lines inside that row and refuses to write when an anchor
 * has moved. The proof that a patch landed is a re-read of the row, not a
 * successful parse.
 *
 * The row is addressed by its id, and every replacement is scoped to the line
 * range between that row's header and the next row's header — so editing the
 * lane can never reach a sibling row, however the file is later reordered.
 */

/** Line range of one composition row: its header through the next row header. */
export function laneRowRange(lines, rowId) {
  const header = lines.findIndex((line) => new RegExp(`^ {4}- id: ${rowId}\\s*$`).test(line))
  if (header === -1) throw new Error(`the composition has no "${rowId}" row`)
  let end = lines.length
  for (let i = header + 1; i < lines.length; i++) {
    if (/^ {4}- id: /.test(lines[i])) { end = i; break }
  }
  return [header, end]
}

/** Replace `key: …` inside [from, to), optionally only after an anchor key. */
export function replaceKey(lines, from, to, key, value, { after } = {}) {
  let cursor = from
  if (after !== undefined) {
    const anchor = lines.findIndex((line, i) => i >= from && i < to && new RegExp(`^\\s*${after}:`).test(line))
    if (anchor === -1) throw new Error(`the row has no "${after}:" key to anchor on`)
    cursor = anchor + 1
  }
  for (let i = cursor; i < to; i++) {
    if (new RegExp(`^\\s*${key}:`).test(lines[i])) {
      const indent = lines[i].match(/^\s*/)[0]
      lines[i] = `${indent}${key}: ${value}`
      return i
    }
  }
  throw new Error(`the row has no "${key}:" key to replace`)
}

/** Read one key's raw value out of a line range, or undefined. */
export function readKey(lines, from, to, key, { after } = {}) {
  let cursor = from
  if (after !== undefined) {
    const anchor = lines.findIndex((line, i) => i >= from && i < to && new RegExp(`^\\s*${after}:`).test(line))
    if (anchor === -1) return undefined
    cursor = anchor + 1
  }
  for (let i = cursor; i < to; i++) {
    const match = lines[i].match(new RegExp(`^\\s*${key}:\\s*(.*)$`))
    if (match !== null) return match[1].trim()
  }
  return undefined
}

/** Read the lane as the console shows it. */
export function readLane(text, rowId = 'tool-subagent-cheap') {
  const lines = text.split('\n')
  const [from, to] = laneRowRange(lines, rowId)
  const allow = readKey(lines, from, to, 'allow')
  return {
    toolName: readKey(lines, from, to, 'toolName'),
    subagentProvider: readKey(lines, from, to, 'provider'),
    modelProvider: readKey(lines, from, to, 'provider', { after: 'agentOptions' }),
    model: readKey(lines, from, to, 'model', { after: 'agentOptions' }),
    maxTokens: Number(readKey(lines, from, to, 'maxTokens', { after: 'agentOptions' })),
    allow: allow === undefined ? [] : allow.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean),
    backgroundMode: readKey(lines, from, to, 'backgroundMode'),
  }
}

/**
 * Apply a lane patch to a composition file's text.
 *
 * The proof that the patch landed is a re-read: the returned lane must name its
 * tool, and every key the caller set must read back as what was asked for. A
 * silent half-patch — the allow-list replaced and the model not — is the one
 * outcome this cannot return.
 */
export function patchLane(text, patch, rowId = 'tool-subagent-cheap') {
  const editable = ['subagentProvider', 'modelProvider', 'model', 'maxTokens', 'backgroundMode', 'allow']
  const unknown = Object.keys(patch).filter((key) => !editable.includes(key))
  if (unknown.length > 0) {
    // Silently ignoring a key the caller believed it set is how a config editor
    // reports success for a typo, so an unknown key is an error, not a no-op.
    throw new Error(`not editable on the lane row: ${unknown.join(', ')} (editable: ${editable.join(', ')})`)
  }
  const lines = text.split('\n')
  const [from, to] = laneRowRange(lines, rowId)
  if (patch.subagentProvider !== undefined) replaceKey(lines, from, to, 'provider', patch.subagentProvider)
  if (patch.modelProvider !== undefined) replaceKey(lines, from, to, 'provider', patch.modelProvider, { after: 'agentOptions' })
  if (patch.model !== undefined) replaceKey(lines, from, to, 'model', patch.model, { after: 'agentOptions' })
  if (patch.maxTokens !== undefined) replaceKey(lines, from, to, 'maxTokens', String(patch.maxTokens), { after: 'agentOptions' })
  if (patch.backgroundMode !== undefined) replaceKey(lines, from, to, 'backgroundMode', patch.backgroundMode)
  if (patch.allow !== undefined) {
    const list = patch.allow.map((tool) => tool.trim()).filter(Boolean)
    if (list.length === 0) throw new Error('an empty allow-list would leave the child with no tools at all')
    replaceKey(lines, from, to, 'allow', `[${list.join(', ')}]`)
  }
  const next = lines.join('\n')
  const after = readLane(next, rowId)
  if (after.toolName === undefined) throw new Error('the patched row no longer names its tool')
  for (const key of ['modelProvider', 'model', 'maxTokens', 'allow']) {
    if (patch[key] === undefined) continue
    const want = Array.isArray(patch[key]) ? patch[key].join(', ') : patch[key]
    const got = Array.isArray(after[key]) ? after[key].join(', ') : after[key]
    if (String(want) !== String(got)) throw new Error(`the patch did not land: ${key} reads back as ${JSON.stringify(got)}`)
  }
  return { text: next, lane: after }
}
