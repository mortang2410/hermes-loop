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

function fakeServices(conclusionText, { agentSkills, sessionAgent, sessionAgentSkills, presets } = {}) {
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
  // There is ONE context, as in the host: `setupAndPublish` runs
  // `setup?.(prepared.agent.ctx, prepared.agent)` and `publish` returns that same
  // agent (dsh-agent-loop/lib/index.js), so what setup receives IS `agent.ctx`.
  // An earlier fixture modelled two contexts with independent switches, which is
  // a state the host cannot produce (found in review round 2).
  //
  // The context is ALWAYS attached, even when it carries no skills service: the
  // host always mints one, so "context exists, `get('skills')` returns undefined"
  // is the real no-service shape. Leaving `agent.ctx` unset instead modelled a
  // context-less agent that the host never produces (found in review round 3).
  //
  // `tools` is present because `setup` always calls `agentCtx.tools.restrict`.
  const agentCtx = {
    get: (name) => (name === 'skills' ? agentSkills : undefined),
    tools: { restrict() {} },
  }
  agent.ctx = agentCtx
  // The triggering session's own agent, as `ctx.agents.get(sessionId)` resolves it.
  // In the host this agent is the one `composeAgent` mounted a preset onto, so its
  // scoped read carries the preset's provider rows; the review agent created below
  // does not. Tests that are not about that distinction leave this unset, which is
  // the "session agent not live" shape the plugin must tolerate.
  const liveSessionAgent = sessionAgent === undefined ? undefined : {
    ...sessionAgent,
    ctx: { get: (name) => (name === 'skills' ? sessionAgentSkills : undefined) },
  }
  return {
    created,
    agent,
    agentCtx,
    sessionAgent: liveSessionAgent,
    // The host plane exposes the preset registry as `agentPresets`. The plugin
    // reaches it with `ctx.get('agentPresets', false)`, so a test that does not
    // supply one models a host without that service, which is the `unprovable`
    // path the row-label fallback exists for.
    //
    // `composedPreset` is bound to the SESSION agent's context, as the host is:
    // the review agent is created by this plugin and never mounts a preset, so a
    // proof lookup against it must answer `undefined`. A fake that answered for
    // every context would model a state the host cannot produce and would hide
    // exactly the defect under test.
    presets: presets === undefined ? undefined : buildPresets(presets, liveSessionAgent),
    agents: {
      create: async (opts) => {
        created.push(opts)
        if (typeof opts.setup === 'function') await opts.setup(agentCtx, agent)
        return { agent, dispose: async () => {} }
      },
      get: (id) => (liveSessionAgent !== undefined && sessionAgent && sessionAgent.id === id ? liveSessionAgent : undefined),
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'prov', model: 'mdl' }) },
  }
}

/**
 * A preset registry as the host exposes it, modelling structural provider proof.
 * `presetId` is the preset the SESSION agent joined; `rows` is that preset's
 * composition inventory. Both default to the healthy shape: the session agent
 * joined `standard` and its skill provider row is enabled and ACTIVE.
 *
 * `presetId: null` models "the session agent joined no preset". A destructuring
 * default replaces an explicit `undefined` argument, so `undefined` cannot
 * express that case in the options object.
 */
function buildPresets({ presetId = 'standard', rows = [{ entryId: 'skill-filesystem', moduleName: REQUIRED_PROVIDER, enabled: true, fiberState: 2 }] } = {}, liveSessionAgent) {
  const joined = presetId === null ? undefined : presetId
  const preset = { id: joined === undefined ? 'standard' : joined, isDefault: false, rows }
  return {
    composedPreset: (agentCtx) => (liveSessionAgent !== undefined && agentCtx === liveSessionAgent.ctx ? joined : undefined),
    compositionInventory: async () => [preset],
  }
}

const REQUIRED_PROVIDER = '@deepseek-ai/dsh-skill-filesystem'

// A skills service as the review agent's own ctx exposes it. Tests that are not
// about the catalog give the agent one of these, so the short-catalog guard does
// not withhold the skill conclusion they are actually exercising.
//
// Rows carry `provider` because `dsh-skill` stamps one on EVERY row it returns:
// `register()` sets `provider: skill.provider ?? 'runtime'` for runtime skills,
// and each provider stamps its own name on the rows it discovers (the filesystem
// provider uses `filesystem`). A row without a provider is therefore not a shape
// the host can produce, and the guard reads that field to tell a catalog that a
// real provider answered from one that only merged runtime registrations.
const catalogService = (skills, complete = true) => ({
  // `map(provided)` would pass the array INDEX as the second argument, silently
  // stamping `provider: 0`. Call it through an arrow so the default applies.
  snapshot: async () => ({ skills: skills.map((row) => provided(row)), complete }),
})

/**
 * Stamp the provider name a real registry would have put on this row. The row's
 * own `provider` wins when it carries one, so a fixture can model a runtime row.
 */
const provided = (row, provider = 'filesystem') => ({ ...row, provider: row.provider ?? provider })

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
    get: (name) => (name === 'agentPresets' ? services.presets : undefined),
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
  // These cases are about the memory channel, not the catalog, so the review
  // agent exposes a usable (empty) catalog and the short-catalog guard stays out
  // of the way. Without an agent-scoped service the guard would correctly
  // withhold the skill half, which is not what these cases exercise.
  const services = fakeServices('```json\n' + conclusionText + '\n```', { agentSkills: catalogService([]) })
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
