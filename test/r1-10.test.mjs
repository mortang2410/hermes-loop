// R1-10 red test (verifier copy only; not part of the frozen target).
// Claim: a malformed `files` field in a create/patch conclusion discards a valid
// memory sub-conclusion, because parseConclusion returns one value for both
// channels and returns undefined on any skill-side failure.
// Expected: src/index.js:370-371 says the memory channel and the skill channel
// are isolated per channel ("fail-closed 按通道隔离"), and docs/design-dsh.md:149
// says the two channels are independently guarded. The skill part is refused
// and the memory survives.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'hermes-loop-r1-10-'))

const require = createRequire(import.meta.url)
const plugin = require('../src/index.js')
const { parseConclusion } = plugin.__internals

const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const memo = { action: 'add', store: 'user', text: 'likes terse answers' }

test('R1-10: a malformed files entry refuses the skill part but keeps a valid memory sub-conclusion', () => {
  const conclusion = {
    action: 'create',
    skill: 'r1-10-probe',
    description: 'Use when probing reference files.',
    body: '# probe\nSee references/setup.md.\n',
    files: [{ path: '../escape.md', content: 'x\n' }],
    memory: memo,
  }
  const result = parseConclusion(fence(conclusion))
  assert.notEqual(result, undefined, 'the memory sub-conclusion must survive a malformed skill part')
  assert.equal(result.memory?.action, 'add', 'the valid memory action must be kept')
  assert.equal(result.memory?.store, 'user', 'the valid memory store must be kept')
  assert.equal(result.memory?.text, 'likes terse answers', 'the valid memory text must be kept')
  assert.notEqual(result.action, 'create', 'the create skill part must be refused')
  assert.notEqual(result.action, 'patch', 'the patch skill part must be refused')
  assert.equal(result.skill, undefined, 'no skill name may survive a refused skill part')
  assert.equal(result.body, undefined, 'no SKILL.md body may survive a refused skill part')
  assert.equal(result.files, undefined, 'no reference files may survive a refused skill part')
})

test('control (passes now): a valid skill keeps its files when the memory field is malformed', () => {
  const conclusion = {
    action: 'create',
    skill: 'r1-10-probe',
    description: 'Use when probing reference files.',
    body: '# probe\nSee references/setup.md.\n',
    files: [{ path: 'references/setup.md', content: 'x\n' }],
    memory: { action: 'add', store: 'galaxy', text: 'x' },
  }
  const result = parseConclusion(fence(conclusion))
  assert.equal(result.action, 'create')
  assert.equal(result.memory, undefined)
  assert.equal(result.files.length, 1)
})

test('control (passes now): a nothing conclusion keeps a valid memory entry', () => {
  const result = parseConclusion(fence({ action: 'nothing', memory: memo }))
  assert.equal(result.action, 'nothing')
  assert.equal(result.memory?.text, 'likes terse answers')
})

// Decided with R1-10 (ledger 4c0fd19e): memory is kept whenever it parses, including
// when the top-level action is unknown, and a refused skill part is reported.
test('R1-10 unknown action: a valid memory entry is kept and the refusal is reported', () => {
  const reasons = []
  const result = parseConclusion(fence({ action: 'rewrite', memory: memo }), (reason) => reasons.push(reason))
  assert.notEqual(result, undefined, 'a valid memory entry must survive an unknown top-level action')
  assert.equal(result.action, 'nothing')
  assert.equal(result.memory?.text, 'likes terse answers')
  assert.equal(reasons.length, 1, 'the refused skill part must be reported once')
  assert.match(reasons[0], /unknown action/)
})
