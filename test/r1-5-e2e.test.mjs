import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// R1-5 e2e. The harness below is copied from test/loop.test.mjs (lines 340-486 and
// 1874-1895 there), because loop.test.mjs does not export it. Keep the two in step.
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'r1-5-e2e-home-'))
const require = createRequire(import.meta.url)
const plugin = require('../src/index.js')

function fakeServices(conclusionText) {
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
  const agentCtx = { get: () => undefined, tools: { restrict() {} } }
  agent.ctx = agentCtx
  return {
    created,
    agent,
    agentCtx,
    suggestions: { query: async () => ({ suggestions: [], rendered: '', degraded: false }) },
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
  const named = new Map()
  const cleanups = []
  const infos = []
  const warns = []
  const routes = []
  const ctx = {
    logger: { info: (m) => infos.push(String(m)), warn: (m) => warns.push(String(m)) },
    // 信任栅栏：默认放行（undefined）；用例可用 services.connection 覆盖为 401/403
    connection: { requestRejection: () => undefined },
    on: (name, fn) => { handlers.push(fn); if (!named.has(name)) named.set(name, []); named.get(name).push(fn); return () => {} },
    effect: (fn) => { cleanups.push(fn()) },
    skills: { snapshot: async () => ({ skills: [{ name: 'known-skill', description: 'a known skill about deploys', invocation: { modelInvocable: true }, provider: 'filesystem' }], complete: true }) },
    // 静态注入契约：服务直接挂在 ctx 上；settings 缺席时走 config+defaults 回退
    settings: undefined,
    // `ctx.get(name, strict)` is how the plugin reaches a service that is NOT in
    // its static inject list. `agentPresets` is read that way (strict=false, so a
    // host without the registry yields undefined instead of throwing), which the
    // plugin treats as "cannot prove either way" and degrades to row labels.
    get: (name) => (name === 'skillRouterSuggestions' ? services.suggestions : undefined),
    ...services,
  }
  // 宿主面动态注入 webServer（skills-management share-services 同款，已验证可用）
  const calls = ctx.inject ? [...ctx.inject] : []
  ctx.inject = (deps, cb) => { calls.push(deps); if (deps.includes('webServer')) cb({ webServer: { register: (route) => routes.push(route) } }) }
  plugin.apply(ctx, config)
  return {
    fire: (session, event) => { for (const h of handlers) h(session, event) },
    // Deliver one host event to ONLY the listeners registered for that name, with
    // the payload the host actually sends. `fire` cannot express this: it hands
    // every event to every handler, so a named event would arrive at the
    // session/event handlers too, carrying a payload they never see in production.
    emit: (name, payload) => { for (const h of named.get(name) || []) h(payload) },
    infos, warns, cleanups, routes,
  }
}

const completedTurn = { type: 'turn/end', data: { reason: { kind: 'completed' } } }

async function runE2E(config, conclusionText) {
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-mem-e2e-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const notices = []
  // These cases are about the memory channel, so the fake router answers with a
  // healthy empty suggestion block and the review runs exactly as it would on a
  // host where nothing in the library fits the session.
  const services = fakeServices('```json\n' + conclusionText + '\n```')
  const t = setupPlugin(config, services)
  const session = {
    id: 'session-mem-e2e',
    header: {},
    deriveMessages: () => [{ role: 'user', content: 'do the thing' }],
    append: (type, data) => notices.push(data),
  }
  t.fire(session, completedTurn)
  await new Promise((r) => setTimeout(r, 90))
  const followup = services.created.find((c) => c && c.content)
  return { home, oldHome, notices, t, followup }
}


// ── R1-5 e2e (verifier, appended to a copy of loop.test.mjs) ──
// Induced: the SKILL.md rename fails with ENOSPC during an auto-mode review of a
// combined conclusion (skill create + memory add). The memory channel of the same
// conclusion is independent (see the comment at src/index.js:2150), so it must
// still land and echo a notice.
const r15Fs = createRequire(import.meta.url)('node:fs/promises')
test('R1-5 e2e: a failed skill write does not skip the memory channel of the same conclusion', async () => {
  const conclusion = JSON.stringify({
    action: 'create', skill: 'r15-e2e-skill', description: 'has both channels', body: 'body here',
    memory: { action: 'add', store: 'memory', text: 'deploy needs otp' },
  })
  const realRename = r15Fs.rename
  r15Fs.rename = async (from, to) => {
    if (String(to).endsWith('/SKILL.md')) throw Object.assign(new Error('ENOSPC: injected rename failure for SKILL.md'), { code: 'ENOSPC' })
    return realRename(from, to)
  }
  let r
  try {
    r = await runE2E({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, conclusion)
  } finally { r15Fs.rename = realRename }
  try {
    assert.match(await readFile(join(r.home, 'memory', 'MEMORY.md'), 'utf8'), /§ deploy needs otp/, 'memory entry was not written')
    assert.ok(r.notices.some((n) => n.source && typeof n.source.summary === 'string' && n.source.summary.includes('记忆')), 'no memory notice reached the source session')
  } finally {
    if (r.oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = r.oldHome
    await rm(r.home, { recursive: true, force: true })
  }
})
