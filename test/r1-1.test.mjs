// R1-1 red test (verifier scratch copy; not part of the frozen target).
// Run: TMPDIR=<scratch>/tmp node --test test/r1-1.test.mjs
// Temp dirs are created under TMPDIR and left in place (this file deletes nothing).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const plugin = require('../src/index.js')
const { sha256, buildSkillMd, applyConclusion } = plugin.__internals

const TAIL = 'TAIL-MARKER'
const DESC = 'Use when testing the big skill.'
// About 21.7 KiB on disk, with a marker in the last line.
const BODY = '# big\n' + 'para line of text\n'.repeat(1200) + TAIL + '\n'
const FULL = buildSkillMd('big-skill', DESC, BODY)
// The body a model writes after reading what the review sees: the visible
// 8 KiB of the body (no frontmatter), with one line edited.
const bodyStart = FULL.indexOf('\n\n') + 2
const PATCHED_BODY = FULL.slice(bodyStart, 8 * 1024)
  .replace('para line of text', 'para line of edited text')
  .replace(/\s+$/, '')

const COMPLETED = { type: 'turn/end', data: { reason: { kind: 'completed' } } }
const catalogService = (skills) => ({
  snapshot: async () => ({ skills: skills.map((r) => ({ ...r, provider: r.provider ?? 'filesystem' })), complete: true }),
})

function fakeServices(conclusionText, row) {
  const created = []
  const agentCtx = { get: (name) => (name === 'skills' ? catalogService([row]) : undefined), tools: { restrict() {} } }
  const agent = {
    session: { seq: 0, events: [{ seq: 1, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: conclusionText }] } } }] },
    followup(message) { created.push(message) },
    whenIdle: async () => {},
    cancel() {},
    ctx: agentCtx,
  }
  return {
    created,
    agents: {
      create: async (opts) => {
        created.push(opts)
        if (typeof opts.setup === 'function') await opts.setup(agentCtx, agent)
        return { agent, dispose: async () => {} }
      },
      get: () => undefined,
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'prov', model: 'mdl' }) },
  }
}

function setupPlugin(config, services) {
  const handlers = []
  const cleanups = []
  const ctx = {
    logger: { info() {}, warn() {} },
    connection: { requestRejection: () => undefined },
    on: (name, fn) => { handlers.push(fn); return () => {} },
    effect: (fn) => { cleanups.push(fn()) },
    skills: { snapshot: async () => ({ skills: [], complete: true }) },
    settings: undefined,
    get: () => undefined,
    ...services,
  }
  ctx.inject = (deps, cb) => { if (deps.includes('webServer')) cb({ webServer: { register() {} } }) }
  plugin.apply(ctx, config)
  return { fire: (session, event) => { for (const h of handlers) h(session, event) } }
}

// Runs one full review with the 21 KiB skill as the only catalog row, and
// returns the skill dir plus the prompt the review agent was sent.
async function runReview(responseText) {
  const home = await mkdtemp(join(tmpdir(), 'r1-1-e2e-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const skillDir = join(home, 'skills', 'big-skill')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), FULL)
    const row = { name: 'big-skill', description: DESC, resourceBase: { kind: 'directory', path: skillDir }, invocation: { modelInvocable: true } }
    const services = fakeServices(responseText, row)
    const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, services)
    const session = { id: 'session-r1-1', header: {}, deriveMessages: () => [{ role: 'user', content: 'we used big-skill today' }] }
    t.fire(session, COMPLETED)
    await new Promise((r) => setTimeout(r, 400))
    const followup = services.created.find((c) => c && c.content)
    assert.ok(followup, 'harness check: the review must reach the model with a prompt')
    return { skillDir, prompt: followup.content[0].text }
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  }
}

test('R1-1 injection: the review prompt must not show a 21 KiB SKILL.md cut at 8 KiB under its full-file baseHash', async () => {
  const { prompt } = await runReview('```json\n{"action":"nothing"}\n```')
  assert.ok(prompt.includes('### suspect: big-skill'), 'harness check: the skill reached the review as a suspect')
  assert.ok(
    prompt.includes(TAIL) || !prompt.includes(`baseHash: ${sha256(FULL)}`),
    'the suspect is shown cut at 8 KiB (tail missing) but carries the baseHash of the full file, so a patch can be built on text the review never saw in full',
  )
})

test('R1-1 writer: a patch whose body came from the 8 KiB view must not replace the 21 KiB SKILL.md and drop its tail', async () => {
  const home = await mkdtemp(join(tmpdir(), 'r1-1-writer-'))
  const g = join(home, 'skills')
  await mkdir(join(g, 'big-skill'), { recursive: true })
  await writeFile(join(g, 'big-skill', 'SKILL.md'), FULL)
  const res = await applyConclusion(
    { action: 'patch', skill: 'big-skill', body: PATCHED_BODY, rationale: 'r1-1', baseHash: sha256(FULL), baseDescription: DESC, files: [] },
    { globalDir: g },
  )
  const after = await readFile(join(g, 'big-skill', 'SKILL.md'), 'utf8')
  assert.ok(
    res.result !== 'patched' || after.includes(TAIL),
    `expected a refusal or the tail kept; got result=${res.result}, tail ${after.includes(TAIL) ? 'kept' : 'LOST'}, file ${FULL.length} -> ${after.length} chars`,
  )
})

test('R1-1 end to end: a patch answering the 8 KiB view must not land and drop the tail', async () => {
  const conclusion = JSON.stringify({ action: 'patch', skill: 'big-skill', body: PATCHED_BODY, baseHash: sha256(FULL), baseDescription: DESC })
  const { skillDir } = await runReview('```json\n' + conclusion + '\n```')
  const after = await readFile(join(skillDir, 'SKILL.md'), 'utf8')
  assert.ok(
    after === FULL || after.includes(TAIL),
    `expected the file unchanged or the tail kept; file ${FULL.length} -> ${after.length} chars, tail ${after.includes(TAIL) ? 'kept' : 'LOST'}`,
  )
})

// Marker: a body that carries the review's truncation marker is a patch built on
// a cut view, so it is refused even when the file is within the limit.
test('R1-1 writer: a body carrying the truncation marker is refused, nothing written', async () => {
  const home = await mkdtemp(join(tmpdir(), 'r1-1-marker-'))
  const g = join(home, 'skills')
  const SHORT = buildSkillMd('short-skill', DESC, '# short\nbody v1\n')
  await mkdir(join(g, 'short-skill'), { recursive: true })
  await writeFile(join(g, 'short-skill', 'SKILL.md'), SHORT)
  const res = await applyConclusion(
    { action: 'patch', skill: 'short-skill', body: '# short\nbody v2\n…（截断）\n', rationale: 'r1-1 marker', baseHash: sha256(SHORT), baseDescription: DESC, files: [] },
    { globalDir: g },
  )
  assert.equal(res.result, 'rejected', `expected rejected; got ${res.result}`)
  assert.equal(await readFile(join(g, 'short-skill', 'SKILL.md'), 'utf8'), SHORT, 'SKILL.md must not change')
})
