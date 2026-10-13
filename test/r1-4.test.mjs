// R1-4 red test: one unreadable reference file must not abort the whole review.
// Harness copied from test/loop.test.mjs (its helpers are not exported).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const plugin = require('../src/index.js')
const { sha256 } = plugin.__internals

const completedTurn = { type: 'turn/end', data: { reason: { kind: 'completed' } } }
const catalogService = (skills) => ({
  snapshot: async () => ({ skills: skills.map((row) => ({ ...row, provider: row.provider ?? 'filesystem' })), complete: true }),
})
const provided = (row) => ({ ...row, provider: row.provider ?? 'filesystem' })

function fakeServices(conclusionText, agentSkills) {
  const created = []
  const agent = {
    session: {
      seq: 0,
      events: [{ seq: 1, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: conclusionText }] } } }],
    },
    followup(message) { created.push(message) },
    whenIdle: async () => {},
    cancel() {},
  }
  const agentCtx = { get: (name) => (name === 'skills' ? agentSkills : undefined), tools: { restrict() {} } }
  agent.ctx = agentCtx
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
  const warns = []
  const infos = []
  const cleanups = []
  const ctx = {
    logger: { info: (m) => infos.push(String(m)), warn: (m) => warns.push(String(m)) },
    connection: { requestRejection: () => undefined },
    on: (name, fn) => { handlers.push(fn); return () => {} },
    effect: (fn) => { cleanups.push(fn()) },
    get: () => undefined,
    ...services,
  }
  ctx.inject = (deps, cb) => { if (deps.includes('webServer')) cb({ webServer: { register: () => {} } }) }
  plugin.apply(ctx, config)
  return { fire: (session, event) => { for (const h of handlers) h(session, event) }, warns, infos }
}

const waitFor = async (pred, ms) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 25))
  }
}

const description = 'topic overview for deploy work'
const original = `---\nname: "topic-skill"\ndescription: "${description}"\n---\n\nbody v1\n`

// One suspect skill with two reference files. `unreadable` makes setup.md mode 000.
// The conclusion is one patch of SKILL.md plus one memory add, so both channels
// of the same conclusion are exercised. Caller must call close().
async function scenario({ unreadable }) {
  const home = await mkdtemp(join(tmpdir(), 'r1-4-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const skillDir = join(home, 'skills', 'topic-skill')
  const setupPath = join(skillDir, 'references', 'setup.md')
  await mkdir(join(skillDir, 'references'), { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), original)
  await writeFile(setupPath, 'setup v1\n')
  await writeFile(join(skillDir, 'references', 'ok.md'), 'ok v1\n')
  if (unreadable) {
    await chmod(setupPath, 0o000)
    // Precondition: root ignores mode 000, which would make the red tests pass for the wrong reason.
    const stillReadable = await readFile(setupPath, 'utf8').then(() => true, () => false)
    if (stillReadable) throw new Error('precondition failed: setup.md is still readable after chmod 000 (run as a non-root user)')
  }
  const conclusion = JSON.stringify({
    action: 'patch', skill: 'topic-skill', body: 'body v2', baseHash: sha256(original), baseDescription: description,
    memory: { action: 'add', store: 'memory', text: 'deploy needs otp', rationale: 'ci fact' },
  })
  const catalog = [provided({ name: 'topic-skill', description, resourceBase: { kind: 'directory', path: skillDir }, invocation: { modelInvocable: true } })]
  const services = fakeServices('```json\n' + conclusion + '\n```', catalogService(catalog))
  const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, services)
  const session = {
    id: 'session-r1-4', header: {},
    deriveMessages: () => [{ role: 'user', content: 'we used topic-skill for deploys; remember the otp rule' }],
    append: () => {},
  }
  t.fire(session, completedTurn)
  await waitFor(() => services.created.some((c) => c && c.content) || t.warns.some((w) => w.includes('review task')), 4000)
  await new Promise((r) => setTimeout(r, 300))
  const followup = services.created.find((c) => c && c.content)
  const reviewWarns = t.warns.filter((w) => w.includes('review task'))
  return {
    home, skillDir, setupPath, followup, reviewWarns,
    prompt: followup ? followup.content[0].text : '',
    async close() {
      await chmod(setupPath, 0o644).catch(() => {})
      if (oldHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = oldHome
      await rm(home, { recursive: true, force: true })
    },
  }
}

test('R1-4 red: the review prompt is sent and the unreadable reference file is listed as not injected', async () => {
  const s = await scenario({ unreadable: true })
  try {
    assert.ok(s.followup !== undefined, `review prompt never sent; the review aborted before dispatch. warns: ${JSON.stringify(s.reviewWarns)}`)
    assert.ok(s.prompt.includes('- references/setup.md ('), 'the unreadable reference file must be listed by name, not dropped')
    assert.ok(!s.prompt.includes('#### references/setup.md'), 'the unreadable reference file must not be injected in full')
    assert.ok(s.prompt.includes('#### references/ok.md\nbaseHash: '), 'the readable reference file must still be injected with its baseHash')
  } finally { await s.close() }
})

test('R1-4 red: the memory part of the same conclusion applies when one reference file is unreadable', async () => {
  const s = await scenario({ unreadable: true })
  try {
    const mem = await readFile(join(s.home, 'memory', 'MEMORY.md'), 'utf8').catch(() => '')
    assert.match(mem, /§ deploy needs otp/, `memory part was not applied. review warns: ${JSON.stringify(s.reviewWarns)}`)
    const skillMd = await readFile(join(s.skillDir, 'SKILL.md'), 'utf8').catch(() => '')
    assert.match(skillMd, /body v2/, 'the skill part of the same conclusion does not touch the unreadable file and should apply')
  } finally { await s.close() }
})

test('R1-4 control: with every reference file readable, the same conclusion applies in full', async () => {
  const s = await scenario({ unreadable: false })
  try {
    assert.ok(s.followup !== undefined, `control: review prompt must be sent. warns: ${JSON.stringify(s.reviewWarns)}`)
    assert.ok(s.prompt.includes(`#### references/setup.md\nbaseHash: ${sha256('setup v1\n')}`), 'control: setup.md is injected with its baseHash')
    assert.match(await readFile(join(s.home, 'memory', 'MEMORY.md'), 'utf8').catch(() => ''), /§ deploy needs otp/, 'control: memory applies')
    assert.match(await readFile(join(s.skillDir, 'SKILL.md'), 'utf8').catch(() => ''), /body v2/, 'control: skill patch applies')
  } finally { await s.close() }
})
