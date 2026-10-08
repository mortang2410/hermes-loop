import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// 测试全程把 DSH_HOME 指向临时目录：插件的 activity.jsonl 审计日志与全局
// skill 目录都按 $DSH_HOME 解析，否则会污染真实 ~/.dsh。
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'hermes-loop-tests-'))

const require = createRequire(import.meta.url)
const plugin = require('../src/index.js')
const {
  reasonKind, contentToText, renderTranscript, rankSuspects, parseConclusion,
  sha256, buildSkillMd, mergeFrontmatter, applyConclusion, descriptionOf, DEFAULTS,
} = plugin.__internals

// ── reasonKind ──────────────────────────────────────────────────────────

test('reasonKind unwraps the {kind} payload and tolerates bare strings', () => {
  assert.equal(reasonKind({ kind: 'completed' }), 'completed')
  assert.equal(reasonKind({ kind: 'aborted' }), 'aborted')
  assert.equal(reasonKind('completed'), 'completed')
  assert.equal(reasonKind(undefined), undefined)
  assert.equal(reasonKind(42), undefined)
})

// ── contentToText / renderTranscript ────────────────────────────────────

test('contentToText extracts text blocks and names tool calls', () => {
  assert.equal(contentToText('plain'), 'plain')
  assert.equal(contentToText([{ type: 'text', text: 'a' }, { type: 'tool_call', name: 'read' }, { type: 'thinking', text: 'skip' }]), 'a\n[tool read]')
  assert.equal(contentToText({ text: 'obj' }), 'obj')
  assert.equal(contentToText(undefined), '')
})

test('renderTranscript keeps the tail and skips empty messages', () => {
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: [] },
    { role: 'user', content: 'second' },
  ]
  const out = renderTranscript(messages, { maxChars: 10_000, maxMessages: 2 })
  assert.match(out, /### user\nsecond/)
  assert.doesNotMatch(out, /first/) // beyond the tail window
  const tiny = renderTranscript([{ role: 'user', content: 'x'.repeat(500) }], { maxChars: 100, maxMessages: 40 })
  assert.ok(tiny.length <= 100 + '…（早段已按保尾策略截断）\n'.length)
  assert.match(tiny, /早段已按保尾策略截断/)
})

// ── rankSuspects ────────────────────────────────────────────────────────

test('rankSuspects scores name hits above description hits and handles CJK', () => {
  const catalog = [
    { name: 'rust-daily', description: 'daily rust workflow' },
    { name: 'unrelated-skill', description: 'something else entirely' },
    { name: 'deploy-flow', description: '部署流程与回滚步骤' },
  ]
  const transcript = 'we ran the deploy-flow today and had to rollback. 部署流程 worked'
  const ranked = rankSuspects(catalog, transcript)
  assert.equal(ranked[0].name, 'deploy-flow')
  assert.ok(ranked.some((s) => s.name === 'rust-daily') === false) // no hit at all
})

// ── parseConclusion ─────────────────────────────────────────────────────

test('parseConclusion accepts a fenced create conclusion', () => {
  const text = '前置说明\n```json\n{ "action": "create", "skill": "my-skill", "description": "d", "body": "# hi", "rationale": "r" }\n```'
  const c = parseConclusion(text)
  assert.equal(c.action, 'create')
  assert.equal(c.skill, 'my-skill')
  assert.equal(c.body, '# hi')
})

test('parseConclusion accepts patch only with baseHash (CAS input)', () => {
  const good = parseConclusion('{"action":"patch","skill":"a-b","body":"x","baseHash":"deadbeef","baseDescription":"d"}')
  assert.equal(good.action, 'patch')
  assert.equal(good.baseHash, 'deadbeef')
  assert.equal(parseConclusion('{"action":"patch","skill":"a-b","body":"x"}'), undefined)
})

test('parseConclusion fail-closes on junk: bad action, bad name, empty body, non-JSON', () => {
  assert.equal(parseConclusion('{"action":"delete","skill":"a"}'), undefined)
  assert.equal(parseConclusion('{"action":"create","skill":"Bad_Name","description":"d","body":"b"}'), undefined)
  assert.equal(parseConclusion('{"action":"create","skill":"a","description":"","body":"b"}'), undefined)
  assert.equal(parseConclusion('{"action":"create","skill":"a","description":"d","body":""}'), undefined)
  assert.equal(parseConclusion('not json at all'), undefined)
  assert.equal(parseConclusion('{"action":"nothing"}').action, 'nothing')
})

// ── buildSkillMd / descriptionOf ────────────────────────────────────────

test('buildSkillMd emits valid frontmatter and descriptionOf round-trips it', () => {
  const content = buildSkillMd('my-skill', 'does things', '## When to Use\nbody text\n')
  assert.match(content, /^---\n/)
  assert.equal(descriptionOf(content), 'does things')
  const quoted = buildSkillMd('my-skill', 'has "quotes" and\nnewline', 'b')
  assert.equal(descriptionOf(quoted), 'has "quotes" and newline')
})

// ── applyConclusion (real filesystem, temp globalDir) ───────────────────

async function tempGlobalDir() {
  return mkdtemp(join(tmpdir(), 'hermes-loop-test-'))
}

test('applyConclusion: create writes atomically; conflict refuses to overwrite', async () => {
  const dir = await tempGlobalDir()
  try {
    const out = await applyConclusion(
      { action: 'create', skill: 'new-skill', description: 'd1', body: 'body v1' },
      { globalDir: dir })
    assert.equal(out.result, 'created')
    const written = await readFile(join(dir, 'new-skill', 'SKILL.md'), 'utf8')
    assert.match(written, /^---\nname: /)
    assert.match(written, /body v1/)
    // no temp leftovers
    const entries = await readdir(join(dir, 'new-skill'))
    assert.deepEqual(entries, ['SKILL.md'])
    const conflict = await applyConclusion(
      { action: 'create', skill: 'new-skill', description: 'd2', body: 'body v2' },
      { globalDir: dir })
    assert.equal(conflict.result, 'create-conflict')
    assert.match(await readFile(join(dir, 'new-skill', 'SKILL.md'), 'utf8'), /body v1/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('applyConclusion: patch passes CAS when unchanged, fails when file drifted', async () => {
  const dir = await tempGlobalDir()
  try {
    await mkdir(join(dir, 'p-skill'), { recursive: true })
    const original = '---\nname: "p-skill"\ndescription: "orig"\n---\n\nbody v1\n'
    await writeFile(join(dir, 'p-skill', 'SKILL.md'), original)
    const baseHash = sha256(original)
    const ok = await applyConclusion(
      { action: 'patch', skill: 'p-skill', body: 'body v2', baseHash, baseDescription: 'orig' },
      { globalDir: dir })
    assert.equal(ok.result, 'patched')
    const after = await readFile(join(dir, 'p-skill', 'SKILL.md'), 'utf8')
    assert.match(after, /body v2/)
    assert.match(after, /description: "orig"/) // description preserved through patch

    const drifted = await applyConclusion(
      { action: 'patch', skill: 'p-skill', body: 'body v3', baseHash, baseDescription: 'orig' },
      { globalDir: dir })
    assert.equal(drifted.result, 'cas-conflict')

    const missing = await applyConclusion(
      { action: 'patch', skill: 'ghost-skill', body: 'x', baseHash: 'aa' },
      { globalDir: dir })
    assert.equal(missing.result, 'patch-missing')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// ── end-to-end through apply(): fake services drive a full review ───────

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

test('loop end-to-end: threshold fires review, log-only mode logs the conclusion', async () => {
  const conclusion = JSON.stringify({ action: 'nothing', rationale: 'one-off task' })
  const services = fakeServices('```json\n' + conclusion + '\n```')
  const t = setupPlugin({ turnInterval: 2, cooldownMinutes: 0, mode: 'log-only' }, services)
  const session = { id: 'session-real', header: {}, deriveMessages: () => [{ role: 'user', content: 'hi' }] }
  t.fire(session, completedTurn)
  t.fire(session, completedTurn)
  await new Promise((r) => setTimeout(r, 80))
  // action=nothing 结算在 runner 内（无需进 writer），直接落日志
  assert.ok(t.infos.some((m) => m.includes('→ nothing') && m.includes('one-off task')), t.infos.join('|'))
})

test('loop end-to-end: auto mode lands the skill in $DSH_HOME/skills', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-home-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const conclusion = JSON.stringify({ action: 'create', skill: 'e2e-skill', description: 'from e2e test', body: 'e2e body' })
    const services = fakeServices('```json\n' + conclusion + '\n```', { agentSkills: catalogService([]) })
    const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, services)
    const session = { id: 'session-e2e', header: { cwd: home }, deriveMessages: () => [{ role: 'user', content: 'do the thing' }] }
    t.fire(session, completedTurn)
    await new Promise((r) => setTimeout(r, 80))
    const written = await readFile(join(home, 'skills', 'e2e-skill', 'SKILL.md'), 'utf8')
    assert.match(written, /e2e body/)
    assert.match(written, /description: "from e2e test"/)
    // review agent was created zero-tool, standard preset, subagent origin, dedicated namespace
    const createOpts = services.created.find((c) => c && c.sessionId)
    assert.match(createOpts.sessionId, /^hermes-loop-review-/)
    assert.equal(createOpts.meta.origin, 'subagent')
    assert.equal(createOpts.meta.agentPreset, 'standard')
    assert.match(createOpts.meta.cwd, /hermes-loop-home-/)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('exclusions and gating: self/subagent/aborted never count, cooldown gates', async () => {
  const services = fakeServices('```json\n{"action":"nothing"}\n```')
  let reviews = 0
  services.agents.create = async () => { reviews += 1; return { agent: fakeIdleAgent('{"action":"nothing"}'), dispose: async () => {} } }
  const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 60, mode: 'log-only' }, services)
  const session = { id: 'session-gate', header: {}, deriveMessages: () => [] }
  t.fire({ id: 'hermes-loop-review-x', header: {} }, completedTurn) // own namespace
  t.fire({ id: 'session-sub', header: { origin: 'subagent' } }, completedTurn) // subagent
  t.fire(session, { type: 'turn/end', data: { reason: { kind: 'aborted' } } }) // aborted
  t.fire(session, { type: 'assistant/chunk' }) // unrelated event type
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(reviews, 0, 'no review for excluded sessions/events')
  t.fire(session, completedTurn) // 1st completed turn → fires (interval=1)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(reviews, 1)
  t.fire(session, completedTurn) // inside 60min cooldown → no second review
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(reviews, 1)
})

test('tool/call window also triggers; disabled plugin stays silent', async () => {
  const services = fakeServices('```json\n{"action":"nothing"}\n```')
  const t = setupPlugin({ turnInterval: 999, toolCallInterval: 3, cooldownMinutes: 0, mode: 'log-only' }, services)
  const session = { id: 'session-tools', header: {}, deriveMessages: () => [] }
  // tool 计数线与 Hermes 同构：计数随时累计，结算点仍在 turn 尾（不做 mid-turn 触发）
  t.fire(session, { type: 'tool/call' })
  t.fire(session, { type: 'tool/call' })
  t.fire(session, { type: 'tool/call' })
  await new Promise((r) => setTimeout(r, 40))
  assert.ok(t.infos.every((m) => !m.includes('→ nothing')), 'no mid-turn trigger')
  t.fire(session, completedTurn)
  await new Promise((r) => setTimeout(r, 80))
  assert.ok(t.infos.some((m) => m.includes('→ nothing')), 'tool window fired at turn end', t.infos.join('|'))

  const silent = setupPlugin({ enabled: false }, services)
  silent.fire(session, completedTurn)
  await new Promise((r) => setTimeout(r, 40))
  assert.ok(silent.infos.every((m) => !m.includes('log-only mode')))
})

test('unparseable conclusions are dropped with a warn, not written', async () => {
  const services = fakeServices('I think nothing is worth saving.')
  const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, services)
  const session = { id: 'session-junk', header: {}, deriveMessages: () => [] }
  t.fire(session, completedTurn)
  await new Promise((r) => setTimeout(r, 80))
  assert.ok(t.warns.some((m) => m.includes('unparseable')), t.warns.join('|'))
})

function fakeIdleAgent(text) {
  return {
    session: { seq: 0, events: [{ seq: 1, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } }] },
    followup() {}, whenIdle: async () => {}, cancel() {},
  }
}

// ── client API routes (fake webServer) ─────────────────────────────────

function fakeRes() {
  const res = { statusCode: null, body: null }
  res.writeHead = (status) => { res.statusCode = status }
  res.end = (b) => { res.body = b }
  return res
}

test('every route sits behind the connection trust fence', async () => {
  const services = fakeServices('```json\n{"action":"nothing"}\n```')
  services.connection = { requestRejection: () => 401 }
  const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'log-only' }, services)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(t.routes.length, 1)
  const req = { method: 'GET', url: '/api/hermes-loop/status', headers: {} }
  const res = fakeRes()
  t.routes[0].handler(req, res)
  assert.equal(res.statusCode, 401, 'unauthenticated status read is refused')
})

// The remote-access boot script rewrites only URLs under /api/ (plus sidebar,
// git and pet) for paired devices. A route or browser call outside /api/ never
// reaches the host from a Tailscale or LAN device, so pin both ends to /api/.
test('host route and every browser call sit under the remote-rewritten /api/ prefix', async () => {
  const services = fakeServices('```json\n{"action":"nothing"}\n```')
  const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'log-only' }, services)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(t.routes.length, 1)
  assert.equal(t.routes[0].path, '/api/hermes-loop', 'host route must live under /api/')
  const bundle = await readFile(new URL('../client/bundle.js', import.meta.url), 'utf8')
  const fetched = [...bundle.matchAll(/fetch\('(\/[^']*)'/g)].map((m) => m[1])
  assert.ok(fetched.length >= 5, `expected the five browser calls, found ${fetched.length}`)
  for (const url of fetched) {
    assert.ok(url.startsWith('/api/hermes-loop/'), `browser call outside the remote-rewritten prefix: ${url}`)
  }
})

test('GET /api/hermes-loop/status exposes settings, per-session counters and written skills', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-api-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const services = fakeServices('```json\n{"action":"nothing"}\n```')
    const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'log-only' }, services)
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(t.routes.length, 1)
    const route = t.routes[0]
    assert.equal(route.path, '/api/hermes-loop')
    const session = { id: 'session-api', header: {}, deriveMessages: () => [] }
    t.fire(session, completedTurn)
    await new Promise((r) => setTimeout(r, 80))
    const res = fakeRes()
    await route.handler({ method: 'GET', url: '/api/hermes-loop/status?sessionId=session-api' }, res)
    const body = JSON.parse(res.body)
    assert.equal(res.statusCode, 200)
    assert.equal(body.settings.mode, 'log-only')
    assert.equal(body.current.turns, 0) // 已被 review 消耗重置
    assert.ok(body.sessions['session-api'].lastReviewAt > 0)
    assert.ok(Array.isArray(body.activity) && body.activity.length > 0)
    assert.ok(Array.isArray(body.written))
    const notFound = fakeRes()
    await route.handler({ method: 'GET', url: '/api/hermes-loop/nope' }, notFound)
    assert.equal(notFound.statusCode, 404)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('GET /status never blocks on a slow skills.snapshot (panel opens instantly)', async () => {
  // 回归：宿主的技能目录冷重扫要数秒（缓存失效后全量重读）。/status 若 await 它，
  // 打开面板 tab 就卡数秒。策略改为 stale-while-revalidate：请求路径只读插件内缓存，
  // 过期才后台单飞刷新（见 src/index.js refreshInvocable 注释）。
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-slow-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const services = fakeServices('```json\n{"action":"nothing"}\n```')
    let fulfilSnapshot
    services.skills = { snapshot: () => new Promise((r) => { fulfilSnapshot = r }) }
    const t = setupPlugin({}, services)
    await new Promise((r) => setTimeout(r, 30))
    const route = t.routes[0]
    // 种一条 usage 行，让 modelInvocable 列可观察
    const session = { id: 'session-slow', header: {}, deriveMessages: () => [] }
    t.fire(session, { type: 'tool/call', data: { name: 'skill', arguments: JSON.stringify({ name: 'slow-skill' }) } })

    // 首次请求：快照永不到达也不得阻塞（本机冷重扫实测 ~3.7s，这里用永不 settle 的 promise 顶格验证）
    const started = Date.now()
    const res = fakeRes()
    await route.handler({ method: 'GET', url: '/api/hermes-loop/status?sessionId=session-slow' }, res)
    const elapsed = Date.now() - started
    assert.equal(res.statusCode, 200)
    assert.ok(elapsed < 500, `status must not await skills.snapshot (took ${elapsed}ms)`)
    const row = JSON.parse(res.body).usage.rows.find((r) => r.skill === 'slow-skill')
    assert.equal(row.modelInvocable, undefined, 'snapshot still pending → column stays undefined (UI shows —)')

    // 后台刷新落地 → 下一次请求不阻塞地拿到新值
    fulfilSnapshot({ skills: [{ name: 'slow-skill', invocation: { modelInvocable: false } }] })
    await new Promise((r) => setTimeout(r, 30))
    const res2 = fakeRes()
    await route.handler({ method: 'GET', url: '/api/hermes-loop/status?sessionId=session-slow' }, res2)
    const row2 = JSON.parse(res2.body).usage.rows.find((r) => r.skill === 'slow-skill')
    assert.equal(row2.modelInvocable, false)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

// 0.1.7-style settings 服务桩：describe() 投影 volatile 值，update() 落到
// store（可注入故障），document-updated 事件手动触发。
function makeSettingsService({ failUpdate, initial } = {}) {
  const updates = []
  const listeners = []
  const store = { ...(initial || {}) }
  return {
    updates, listeners, store,
    describe: () => [{ ns: 'hermes-loop', value: { ...store }, user: { ...store } }],
    update: async (ns, patch) => {
      if (ns !== 'hermes-loop') throw new Error(`No configurable plugin entry "${ns}"`)
      if (failUpdate) throw new Error(failUpdate)
      updates.push({ ...patch })
      Object.assign(store, patch)
    },
    emitDocumentUpdated: (ns) => listeners.forEach((fn) => fn(ns)),
  }
}

test('POST /api/hermes-loop/settings persists the patch via ctx.settings.update (0.1.7)', async () => {
  const services = fakeServices('```json\n{"action":"nothing"}\n```')
  const settings = makeSettingsService()
  const t = setupPlugin({ turnInterval: 5 }, { ...services, settings })
  await new Promise((r) => setTimeout(r, 20))
  const route = t.routes[0]
  const res = fakeRes()
  await route.handler(reqBody({ patch: { mode: 'approval' } }), res)
  const body = JSON.parse(res.body)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(settings.updates, [{ mode: 'approval' }])
  assert.equal(body.settings.mode, 'approval')
})

test('GET /status reflects live settings from the settings document (0.1.7 describe)', async () => {
  const services = fakeServices('```json\n{"action":"nothing"}\n```')
  const settings = makeSettingsService({ initial: { mode: 'log-only', cooldownMinutes: 7 } })
  const t = setupPlugin({}, { ...services, settings })
  await new Promise((r) => setTimeout(r, 20))
  const res = fakeRes()
  await t.routes[0].handler(makeGet('/api/hermes-loop/status'), res)
  const body = JSON.parse(res.body)
  assert.equal(res.statusCode, 200)
  assert.equal(body.settings.mode, 'log-only', 'values from the settings document win over base config')
  assert.equal(body.settings.cooldownMinutes, 7)
})

test('POST /settings survives a failing settings service via the in-memory fallback', async () => {
  const services = fakeServices('```json\n{"action":"nothing"}\n```')
  const settings = makeSettingsService({ failUpdate: 'No configurable plugin entry "hermes-loop"' })
  const t = setupPlugin({}, { ...services, settings })
  await new Promise((r) => setTimeout(r, 20))
  const res = fakeRes()
  await t.routes[0].handler(reqBody({ patch: { mode: 'approval', cooldownMinutes: 3 } }), res)
  const body = JSON.parse(res.body)
  assert.equal(res.statusCode, 200)
  assert.equal(body.settings.mode, 'approval', 'the merge still applies for this run')
  assert.equal(body.settings.cooldownMinutes, 3)
  assert.equal(settings.updates.length, 0, 'the failed update must not be recorded')
  assert.ok(t.warns.some((w) => w.includes('仅本次运行生效')), 'the fallback is announced')
})

function makeGet(url) {
  const req = new (require('node:events').EventEmitter)()
  req.method = 'GET'
  req.url = url
  return req
}

function reqBody(obj) {
  const data = JSON.stringify(obj)
  const req = new (require('node:events').EventEmitter)()
  req.method = 'POST'
  req.url = '/api/hermes-loop/settings'
  process.nextTick(() => { req.emit('data', Buffer.from(data)); req.emit('end') })
  return req
}
reqBody.__doc = 'returns a live EventEmitter; route.handler must attach listeners synchronously'

// ── loop-aware section: registers only when hermes-prompt is absent ────

test('loop-aware section registers when hermesPrompt marker is absent', () => {
  const sections = []
  const ctx = {
    logger: { info() {}, warn() {} },
    on: () => () => {},
    effect: (fn) => fn(),
    get: () => undefined, // 无 hermes-prompt 标记
    systemPrompt: { section: (s) => { sections.push(s); return () => {} } },
    skills: { snapshot: async () => ({ skills: [] }) },
    settings: undefined,
  }
  plugin.apply(ctx, {})
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'hermes:loop-aware')
  assert.equal(sections[0].order, 51)
})

test('loop-aware section is skipped when hermesPrompt marker is present', () => {
  const sections = []
  const ctx = {
    logger: { info() {}, warn() {} },
    on: () => () => {},
    effect: (fn) => fn(),
    get: (name) => name === 'hermesPrompt' ? { version: '0.1.0' } : undefined,
    systemPrompt: { section: (s) => { sections.push(s); return () => {} } },
    skills: { snapshot: async () => ({ skills: [] }) },
    settings: undefined,
  }
  plugin.apply(ctx, {})
  assert.equal(sections.length, 0)
})

// ── source-session notice: appended as plugin notice on write ──────────

test('write outcomes echo a plugin-notice user/message into the source session', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-echo-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const notices = []
    const conclusion = JSON.stringify({ action: 'create', skill: 'echo-skill', description: 'd', body: 'b', rationale: '值得存' })
    const services = fakeServices('```json\n' + conclusion + '\n```', { agentSkills: catalogService([]) })
    const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, services)
    const session = {
      id: 'session-echo',
      header: {},
      deriveMessages: () => [],
      append: (type, data) => { notices.push({ type, data }) },
    }
    t.fire(session, completedTurn)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(notices.length, 1)
    assert.equal(notices[0].type, 'user/message')
    assert.equal(notices[0].data.source.kind, 'plugin')
    assert.equal(notices[0].data.source.plugin, 'hermes-loop')
    assert.equal(notices[0].data.source.form, 'notice')
    assert.match(notices[0].data.source.summary, /echo-skill/)
    assert.match(notices[0].data.source.summary, /值得存/)
    // append 抛错不影响写入流程
    const sessionBroken = {
      id: 'session-echo-broken',
      header: {},
      deriveMessages: () => [],
      append() { throw new Error('append not allowed here') },
    }
    t.fire(sessionBroken, completedTurn)
    await new Promise((r) => setTimeout(r, 100))
    const written = await readFile(join(home, 'skills', 'echo-skill', 'SKILL.md'), 'utf8')
    assert.match(written, /^---/)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

// ── manual review-now route ────────────────────────────────────────────

test('POST review-now starts a review for a live session, bypassing thresholds', async () => {
  const services = fakeServices('```json\n{"action":"nothing","rationale":"manual check"}\n```')
  const live = { id: 'session-manual', header: {}, deriveMessages: () => [] }
  const t = setupPlugin({ turnInterval: 999, cooldownMinutes: 999, mode: 'log-only' }, {
    ...services,
    sessions: { get: (sid) => sid === 'session-manual' ? live : undefined },
  })
  await new Promise((r) => setTimeout(r, 30))
  const route = t.routes[0]
  const post = (body) => new Promise((fulfil) => {
    const res = { statusCode: null, body: null, writeHead(s) { this.statusCode = s }, end(b) { this.body = b } }
    const req = new (require('node:events').EventEmitter)()
    req.method = 'POST'; req.url = '/api/hermes-loop/review-now'
    process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
    route.handler(req, res).then(() => fulfil({ status: res.statusCode, body: JSON.parse(res.body) }))
  })
  // 未知会话 → 404
  const missing = await post({ sessionId: 'session-ghost' })
  assert.equal(missing.status, 404)
  // 空 sessionId → 400
  const empty = await post({})
  assert.equal(empty.status, 400)
  // 正常触发：阈值远未达到也能立即复盘
  const ok = await post({ sessionId: 'session-manual' })
  assert.equal(ok.status, 202)
  assert.equal(ok.body.state, 'started')
  await new Promise((r) => setTimeout(r, 100))
  if (!t.infos.some((m) => m.includes('→ nothing'))) console.log('DEBUG infos:', t.infos, 'warns:', t.warns)
  assert.ok(t.infos.some((m) => m.includes('→ nothing')), 'manual review ran and concluded')
  // review 会话运行中重复点 → already-running（用阻塞 agent 模拟）
  let release
  const gate = new Promise((r) => { release = r })
  services.agents.create = async () => ({ agent: { ...fakeIdleAgent('{"action":"nothing"}'), whenIdle: () => gate }, dispose: async () => {} })
  const again = await post({ sessionId: 'session-manual' })
  assert.equal(again.body.state, 'started')
  await new Promise((r) => setTimeout(r, 30))
  const during = await post({ sessionId: 'session-manual' })
  assert.equal(during.body.state, 'already-running')
  release()
})

// ── skill usage statistics ─────────────────────────────────────────────

test('usage stats: skill tool/call counts, catalog exposure, persisted and exposed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-usage-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const services = fakeServices('```json\n{"action":"nothing"}\n```')
    const t = setupPlugin({ turnInterval: 999, mode: 'log-only' }, services)
    await new Promise((r) => setTimeout(r, 30))
    const route = t.routes[0]
    const session = { id: 'session-usage', header: {}, deriveMessages: () => [] }
    // 模型调用 skill 工具两次（mac-a）+ 一次（mac-b）
    t.fire(session, { type: 'tool/call', data: { name: 'skill', callId: 'c1', arguments: JSON.stringify({ name: 'mac-a' }) } })
    t.fire(session, { type: 'tool/call', data: { name: 'skill', callId: 'c2', arguments: JSON.stringify({ name: 'mac-a' }) } })
    t.fire(session, { type: 'tool/call', data: { name: 'skill', callId: 'c3', arguments: JSON.stringify({ name: 'mac-b' }) } })
    t.fire(session, { type: 'tool/call', data: { name: 'bash', callId: 'c4', arguments: '{}' } }) // 非 skill 工具不计数
    // 目录曝光（skill-catalog 注入）
    t.fire(session, { type: 'user/message', data: { content: [{ type: 'text', text: 'catalog' }], source: { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'mac-a' }, { name: 'ghost-skill' }] } } })
    // 防抖冲洗
    await new Promise((r) => setTimeout(r, 5600))
    const res = { statusCode: null, body: null, writeHead(s) { this.statusCode = s }, end(b) { this.body = b } }
    await route.handler({ method: 'GET', url: '/api/hermes-loop/status?sessionId=session-usage' }, res)
    const body = JSON.parse(res.body)
    if (body.usage.totalCalls !== 3) console.log('DEBUG usage:', JSON.stringify(body.usage), 'warns:', t.warns, 'routes:', t.routes.length)
    assert.equal(body.usage.totalCalls, 3)
    assert.equal(body.usage.rows.find((r) => r.skill === 'mac-a').count, 2)
    assert.ok(body.usage.rows.find((r) => r.skill === 'mac-a').lastUsedAt)
    assert.equal(body.usage.rows.find((r) => r.skill === 'ghost-skill').count, 0) // 只曝光未调用
    assert.equal(body.usage.neverCalled, 1)
    assert.equal(body.usage.catalogEntries, 2)
    // 持久化文件
    const saved = JSON.parse(await readFile(join(home, 'hermes-loop', 'usage.json'), 'utf8'))
    assert.equal(saved.usage['mac-a'].count, 2)
    assert.equal(saved.catalog['ghost-skill'].count, 1)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('usage stats survive a restart (loaded from usage.json)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-usage2-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await mkdir(join(home, 'hermes-loop'), { recursive: true })
    await writeFile(join(home, 'hermes-loop', 'usage.json'), JSON.stringify({ savedAt: 'x', usage: { 'old-skill': { count: 7, lastUsedAt: '2026-08-01T00:00:00.000Z', lastSessionId: 's1' } }, catalog: {} }))
    const services = fakeServices('```json\n{"action":"nothing"}\n```')
    const t = setupPlugin({ turnInterval: 999, mode: 'log-only' }, services)
    await new Promise((r) => setTimeout(r, 30))
    const res = { statusCode: null, body: null, writeHead(s) { this.statusCode = s }, end(b) { this.body = b } }
    await t.routes[0].handler({ method: 'GET', url: '/api/hermes-loop/status?sessionId=' }, res)
    const row = JSON.parse(res.body).usage.rows.find((r) => r.skill === 'old-skill')
    assert.equal(row.count, 7)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('mergeFrontmatter preserves governance keys (disable-model-invocation etc.) on patch', async () => {
  const dir = await tempGlobalDir()
  try {
    await mkdir(join(dir, 'governed'), { recursive: true })
    const original = '---\nname: "governed"\ndescription: "orig"\ndisable-model-invocation: true\nversion: "1.2"\n---\n\nbody v1\n'
    await writeFile(join(dir, 'governed', 'SKILL.md'), original)
    const ok = await applyConclusion(
      { action: 'patch', skill: 'governed', body: 'body v2', baseHash: sha256(original), baseDescription: 'orig' },
      { globalDir: dir })
    assert.equal(ok.result, 'patched')
    const after = await readFile(join(dir, 'governed', 'SKILL.md'), 'utf8')
    assert.match(after, /disable-model-invocation: true/)
    assert.match(after, /version: "1\.2"/)
    assert.match(after, /body v2/)
    assert.equal(descriptionOf(after), 'orig')
    // 纯函数：无 frontmatter 的内容回退为新建
    const fresh = mergeFrontmatter('plain body', 'x', 'd', 'nb')
    assert.match(fresh, /nb/)
    assert.match(fresh, /^---\nname: "x"/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// ── Curator: setModelInvocation + curatorTransitions (pure) ─────────────

const { setModelInvocation, curatorTransitions } = plugin.__internals

test('setModelInvocation toggles disable-model-invocation, preserving other keys and body', () => {
  const base = '---\nname: "s"\ndescription: "d"\nversion: "1"\n---\n\nbody text\n'
  const off = setModelInvocation(base, false)
  assert.match(off, /disable-model-invocation: true/)
  assert.match(off, /version: "1"/)
  assert.match(off, /body text/)
  const on = setModelInvocation(off, true)
  assert.doesNotMatch(on, /disable-model-invocation/)
  assert.match(on, /version: "1"/)
  assert.match(on, /body text/)
  // 无 frontmatter：关=补一块，开=原样
  assert.match(setModelInvocation('no front', false), /^---\ndisable-model-invocation: true\n---\n\nno front/)
  assert.equal(setModelInvocation('no front', true), 'no front')
  // 幂等：重复关不叠加键
  const offTwice = setModelInvocation(off, false)
  assert.equal(offTwice.split('disable-model-invocation').length - 1, 1)
})

test('curatorTransitions: grace / stale / archive / revive / no-auto-unarchive / NaN safety', () => {
  const NOW = '2026-08-30T00:00:00.000Z'
  const days = (n) => new Date(Date.parse(NOW) - n * 86400000).toISOString()
  const opts = { now: NOW, staleDays: 30, archiveDays: 90 }
  const run = (records, usage = {}) => curatorTransitions(
    new Map(Object.entries(records)),
    new Map(Object.entries(usage)),
    opts)
  // 零调用且创建不足 30 天 → 宽限，不动
  assert.equal(run({ 'fresh': { createdAt: days(3), state: 'active' } }).length, 0)
  // 零调用但创建超过 90 天 → 直接归档（宽限只挡到 stale 线）
  assert.deepEqual(run({ 'old-virgin': { createdAt: days(100), state: 'active' } }),
    [{ skill: 'old-virgin', from: 'active', to: 'archived', reason: 'archive' }])
  // 40 天前用过 → stale（只标记）
  assert.deepEqual(run({ 'mid': { createdAt: days(100), state: 'active' } }, { mid: { count: 2, lastUsedAt: days(40) } }),
    [{ skill: 'mid', from: 'active', to: 'stale', reason: 'stale' }])
  // 已 stale 且仍 40 天 → 无重复转移
  assert.equal(run({ 'mid': { createdAt: days(100), state: 'stale' } }, { mid: { count: 2, lastUsedAt: days(40) } }).length, 0)
  // stale 期间又被用到 → 复活
  assert.deepEqual(run({ 'mid': { createdAt: days(100), state: 'stale' } }, { mid: { count: 3, lastUsedAt: days(1) } }),
    [{ skill: 'mid', from: 'stale', to: 'active', reason: 'revive' }])
  // active 且 100 天前用过 → 直接 archived
  assert.deepEqual(run({ 'dead': { createdAt: days(200), state: 'active' } }, { dead: { count: 5, lastUsedAt: days(100) } }),
    [{ skill: 'dead', from: 'active', to: 'archived', reason: 'archive' }])
  // archived 无自动出口——昨天被用过也不复活（恢复只能走 restore 路由）
  assert.equal(run({ 'dead': { createdAt: days(200), state: 'archived' } }, { dead: { count: 9, lastUsedAt: days(1) } }).length, 0)
  // lastRestoredAt 顶 anchor：恢复后不会再立刻归档
  assert.equal(run({ 'dead': { createdAt: days(200), state: 'active', lastRestoredAt: days(1) } }).length, 0)
  // 坏时间戳 fail-safe：不转移
  assert.equal(run({ 'broken': { createdAt: 'not-a-date', state: 'active' } }).length, 0)
})

// ── Curator routes e2e: run → archived + flag flipped; restore → flag removed ──

function postJson(url, obj) {
  const req = new (require('node:events').EventEmitter)()
  req.method = 'POST'
  req.url = url
  process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(obj))); req.emit('end') })
  return req
}

test('curator: manual pass archives an aged managed skill (flag flip), restore reverses it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-curator-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const days = (n) => new Date(Date.now() - n * 86400000).toISOString()
    // 纳管技能落盘 + usage.json 种子（lastRunAt 置新，避免加载时的惰性 pass 抢先跑）
    await mkdir(join(home, 'skills', 'old-skill'), { recursive: true })
    await writeFile(join(home, 'skills', 'old-skill', 'SKILL.md'), '---\nname: "old-skill"\ndescription: "aged"\n---\n\naged body\n')
    await mkdir(join(home, 'skills', 'mid-skill'), { recursive: true })
    await writeFile(join(home, 'skills', 'mid-skill', 'SKILL.md'), '---\nname: "mid-skill"\ndescription: "stale-ish"\n---\n\nmid body\n')
    await mkdir(join(home, 'hermes-loop'), { recursive: true })
    await writeFile(join(home, 'hermes-loop', 'usage.json'), JSON.stringify({
      savedAt: days(0),
      usage: {
        'old-skill': { count: 3, lastUsedAt: days(100) },
        'mid-skill': { count: 2, lastUsedAt: days(40) },
      },
      catalog: {},
      curator: {
        lastRunAt: days(0), runCount: 1, lastSummary: 'seed',
        skills: {
          'old-skill': { createdAt: days(200), state: 'active' },
          'mid-skill': { createdAt: days(200), state: 'active' },
        },
      },
    }))
    const services = fakeServices('```json\n{"action":"nothing"}\n```')
    const t = setupPlugin({}, services)
    await new Promise((r) => setTimeout(r, 50)) // usageLoaded
    const route = t.routes[0]

    // 巡检：old → archived（文件翻键），mid → stale（文件不动）
    const runRes = fakeRes()
    await route.handler(postJson('/api/hermes-loop/curator/run', {}), runRes)
    assert.equal(runRes.statusCode, 200)
    const report = JSON.parse(runRes.body).report
    assert.deepEqual(report.transitions.map((x) => [x.skill, x.to]).sort(),
      [['mid-skill', 'stale'], ['old-skill', 'archived']])
    assert.match(await readFile(join(home, 'skills', 'old-skill', 'SKILL.md'), 'utf8'), /disable-model-invocation: true/)
    assert.doesNotMatch(await readFile(join(home, 'skills', 'mid-skill', 'SKILL.md'), 'utf8'), /disable-model-invocation/)

    // status 快照透出状态与计数
    const statusRes = fakeRes()
    await route.handler({ method: 'GET', url: '/api/hermes-loop/status?sessionId=' }, statusRes)
    const curator = JSON.parse(statusRes.body).curator
    assert.equal(curator.counts.archived, 1)
    assert.equal(curator.counts.stale, 1)
    assert.equal(curator.skills.find((r) => r.skill === 'old-skill').state, 'archived')

    // 恢复：移除治理键 + 状态回 active + lastRestoredAt 顶住再归档
    const restoreRes = fakeRes()
    await route.handler(postJson('/api/hermes-loop/curator/restore', { name: 'old-skill' }), restoreRes)
    assert.equal(restoreRes.statusCode, 200)
    assert.doesNotMatch(await readFile(join(home, 'skills', 'old-skill', 'SKILL.md'), 'utf8'), /disable-model-invocation/)
    const rerunRes = fakeRes()
    await route.handler(postJson('/api/hermes-loop/curator/run', {}), rerunRes)
    assert.equal(JSON.parse(rerunRes.body).report.transitions.length, 0, 'restored skill must not re-archive next pass')

    // 错误路径：非纳管 404，非归档 400，坏名字 400
    const unknown = fakeRes()
    await route.handler(postJson('/api/hermes-loop/curator/restore', { name: 'ghost' }), unknown)
    assert.equal(unknown.statusCode, 404)
    const notArchived = fakeRes()
    await route.handler(postJson('/api/hermes-loop/curator/restore', { name: 'old-skill' }), notArchived)
    assert.equal(notArchived.statusCode, 400)
    const badName = fakeRes()
    await route.handler(postJson('/api/hermes-loop/curator/restore', { name: 'Bad Name' }), badName)
    assert.equal(badName.statusCode, 400)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('curator: pre-existing plugin-created skills are backfilled from the audit ledger', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-backfill-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    // 存量：审计账本里有两条 created 记录；legacy-1 的文件还在，ghost-2 的文件被用户删了
    await mkdir(join(home, 'skills', 'legacy-1'), { recursive: true })
    await writeFile(join(home, 'skills', 'legacy-1', 'SKILL.md'), '---\nname: "legacy-1"\ndescription: "old"\n---\n\nbody\n')
    await mkdir(join(home, 'hermes-loop'), { recursive: true })
    await writeFile(join(home, 'hermes-loop', 'activity.jsonl'), [
      JSON.stringify({ at: '2026-08-28T15:00:00.000Z', event: 'write-outcome', skill: 'legacy-1', result: 'created', path: '/x' }),
      JSON.stringify({ at: '2026-08-28T16:00:00.000Z', event: 'write-outcome', skill: 'ghost-2', result: 'created', path: '/y' }),
      JSON.stringify({ at: '2026-08-29T00:00:00.000Z', event: 'write-outcome', skill: 'legacy-1', result: 'patched', path: '/x' }),
    ].join('\n') + '\n')
    const services = fakeServices('```json\n{"action":"nothing"}\n```')
    const t = setupPlugin({}, services)
    await new Promise((r) => setTimeout(r, 80)) // usageLoaded + backfill
    const res = fakeRes()
    await t.routes[0].handler({ method: 'GET', url: '/api/hermes-loop/status?sessionId=' }, res)
    const skills = JSON.parse(res.body).curator.skills
    const legacy = skills.find((r) => r.skill === 'legacy-1')
    assert.ok(legacy, 'audit-ledger created skill must be backfilled into the managed set')
    assert.equal(legacy.createdAt, '2026-08-28T15:00:00.000Z')
    assert.equal(legacy.state, 'active')
    assert.ok(!skills.some((r) => r.skill === 'ghost-2'), 'deleted skill must not be managed (no ghosts)')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('curator: disabled setting skips the pass; created conclusions get registered as managed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-curator2-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const services = fakeServices('```json\n{"action":"nothing"}\n```')
    const t = setupPlugin({ curatorEnabled: false }, services)
    await new Promise((r) => setTimeout(r, 30))
    const route = t.routes[0]
    const runRes = fakeRes()
    await route.handler(postJson('/api/hermes-loop/curator/run', {}), runRes)
    assert.equal(JSON.parse(runRes.body).report.skipped, 'disabled')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }

  const home2 = await mkdtemp(join(tmpdir(), 'hermes-loop-curator3-'))
  process.env.DSH_HOME = home2
  try {
    const conclusion = JSON.stringify({ action: 'create', skill: 'curator-e2e', description: 'd', body: 'b' })
    const services = fakeServices('```json\n' + conclusion + '\n```', { agentSkills: catalogService([]) })
    const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, services)
    const session = { id: 'session-cur', header: {}, deriveMessages: () => [] }
    t.fire(session, completedTurn)
    await new Promise((r) => setTimeout(r, 120))
    const statusRes = fakeRes()
    await t.routes[0].handler({ method: 'GET', url: '/api/hermes-loop/status?sessionId=' }, statusRes)
    const row = JSON.parse(statusRes.body).curator.skills.find((r) => r.skill === 'curator-e2e')
    assert.ok(row, 'created skill must enter the managed set')
    assert.equal(row.state, 'active')
  } finally {
    process.env.DSH_HOME = oldHome
    await rm(home2, { recursive: true, force: true })
  }
})

// ── signal-accelerated triggering (v0.4) ─────────────────────────────────

function countingServices() {
  const services = fakeServices('```json\n{"action":"nothing"}\n```')
  const counter = { reviews: 0 }
  services.agents.create = async () => { counter.reviews += 1; return { agent: fakeIdleAgent('{"action":"nothing"}'), dispose: async () => {} } }
  return { services, counter }
}

test('signal: aborted turn accelerates the next completed turn below threshold', async () => {
  const { services, counter } = countingServices()
  const t = setupPlugin({ turnInterval: 999, toolCallInterval: 999, cooldownMinutes: 0, mode: 'log-only' }, services)
  const session = { id: 'session-sig-abort', header: {}, deriveMessages: () => [] }
  t.fire(session, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(counter.reviews, 0, 'abort marks the window but never fires mid-turn')
  t.fire(session, completedTurn)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(counter.reviews, 1, 'accelerated window fires at the next completed turn despite thresholds')
  // 信号已被消费：再来一个 completed turn（仍低于阈值）不再触发
  t.fire(session, completedTurn)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(counter.reviews, 1, 'signal is consumed by the review it fired')
})

test('signal: tool failure burst accelerates at the configured minimum', async () => {
  const { services, counter } = countingServices()
  const t = setupPlugin({ turnInterval: 999, toolCallInterval: 999, cooldownMinutes: 0, mode: 'log-only', signalToolFailureMin: 3 }, services)
  const session = { id: 'session-sig-fail', header: {}, deriveMessages: () => [] }
  const okResult = { type: 'tool/result', data: { message: { isError: false, content: [] } } }
  const failResult = { type: 'tool/result', data: { message: { isError: true, content: [] } } }
  t.fire(session, failResult)
  t.fire(session, okResult) // 成功结果不计数
  t.fire(session, failResult)
  t.fire(session, completedTurn) // 只有 2 次失败，未到阈值 → 不触发
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(counter.reviews, 0, 'below the failure minimum: no acceleration')
  t.fire(session, failResult) // 第 3 次失败 → 窗口标记
  t.fire(session, completedTurn)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(counter.reviews, 1, 'third failure accelerates')
})

test('signal: correction words only count real user input, not plugin notices', async () => {
  const { services, counter } = countingServices()
  const t = setupPlugin({ turnInterval: 999, toolCallInterval: 999, cooldownMinutes: 0, mode: 'log-only' }, services)
  const session = { id: 'session-sig-word', header: {}, deriveMessages: () => [] }
  // 我们自己的回显（kind=plugin）和目录注入（kind=skill-catalog）绝不算用户纠正
  t.fire(session, { type: 'user/message', data: { content: [{ type: 'text', text: '这个结果不对吧' }], source: { kind: 'plugin' } } })
  t.fire(session, { type: 'user/message', data: { content: [{ type: 'text', text: '不对' }], source: { kind: 'skill-catalog', entries: [] } } })
  t.fire(session, completedTurn)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(counter.reviews, 0, 'plugin/catalog messages must not accelerate')
  t.fire(session, { type: 'user/message', data: { content: [{ type: 'text', text: '不对，重来' }], source: { kind: 'user' } } })
  t.fire(session, completedTurn)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(counter.reviews, 1, 'correction word in a real user message accelerates')
})

test('signal: master switch disables all acceleration; cooldown still gates signals', async () => {
  const { services, counter } = countingServices()
  const off = setupPlugin({ turnInterval: 999, cooldownMinutes: 0, mode: 'log-only', signalTriggerEnabled: false }, services)
  const session = { id: 'session-sig-off', header: {}, deriveMessages: () => [] }
  off.fire(session, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  off.fire(session, { type: 'user/message', data: { content: [{ type: 'text', text: '不对' }], source: { kind: 'user' } } })
  off.fire(session, completedTurn)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(counter.reviews, 0, 'signalTriggerEnabled=false disables every signal kind')

  // 冷却仍生效：先正常触发一次复盘（turnInterval=1），随后信号命中，
  // 冷却期内的 completed turn 不能点火
  const gated = countingServices()
  const t2 = setupPlugin({ turnInterval: 1, cooldownMinutes: 60, mode: 'log-only' }, gated.services)
  const s2 = { id: 'session-sig-cool', header: {}, deriveMessages: () => [] }
  t2.fire(s2, completedTurn)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(gated.counter.reviews, 1)
  t2.fire(s2, { type: 'turn/end', data: { reason: { kind: 'aborted' } } }) // 信号命中
  t2.fire(s2, completedTurn) // 冷却中 → 不应触发
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(gated.counter.reviews, 1, 'cooldown gates signal-accelerated reviews too')
})

test('parseCorrectionWords splits comma/enumeration separators and lowercases', () => {
  const { parseCorrectionWords, matchCorrectionWord } = plugin.__internals
  assert.deepEqual(parseCorrectionWords('不对, Wrong， 重来；;Try Again\n别这样'), ['不对', 'wrong', '重来', 'try again', '别这样'])
  assert.equal(matchCorrectionWord('你这个结果 Wrong 吧', parseCorrectionWords('wrong')), 'wrong')
  assert.equal(matchCorrectionWord('完全正常', parseCorrectionWords('不对,错了')), undefined)
})

// ── 审查修复回归（2026-08-30 code review round）─────────────────────────

test('review fix: patch succeeds for skills with description longer than the catalog cap', async () => {
  // 回归 P1-1：baseDescription 曾用目录截断值做 CAS 基准，长描述技能永远 cas-conflict
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-longdesc-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const longDesc = 'd'.repeat(600) // 超过 catalogDescriptionMax 默认 500
    const skillDir = join(home, 'skills', 'long-desc-skill')
    await mkdir(skillDir, { recursive: true })
    const original = `---\nname: "long-desc-skill"\ndescription: "${longDesc}"\n---\n\noriginal body\n`
    await writeFile(join(skillDir, 'SKILL.md'), original)
    const conclusion = JSON.stringify({
      action: 'patch', skill: 'long-desc-skill', body: 'patched body',
      baseHash: sha256(original), baseDescription: longDesc,
    })
    const catalog = [provided({ name: 'long-desc-skill', description: longDesc.slice(0, 500), resourceBase: { kind: 'directory', path: skillDir }, invocation: { modelInvocable: true } })]
    // snapshot 返回目录截断后的 description（复现真实环境），resourceBase 在全局库内
    const services = fakeServices('```json\n' + conclusion + '\n```', { agentSkills: catalogService(catalog) })
    const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, services)
    const session = { id: 'session-longdesc', header: {}, deriveMessages: () => [{ role: 'user', content: 'we used long-desc-skill today' }] }
    t.fire(session, completedTurn)
    await new Promise((r) => setTimeout(r, 120))
    assert.match(await readFile(join(skillDir, 'SKILL.md'), 'utf8'), /patched body/, 'long-description skill must be patchable')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('review fix: project-level suspects are not injected (writer only knows the global library)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-proj-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    // The project-scoped row goes through the AGENT-scoped service, because that
    // is the route that reaches the filesystem provider's user skills. Supplying
    // it through the plugin ctx would take the partial fallback and misrepresent
    // where a project skill actually appears (raised in review round 4).
    //
    // The file must EXIST on disk. Without it the later `readFile` throws and
    // `continue`s before the globalRoot filter is reached, so the assertion held
    // even with the filter deleted: it passed for the wrong reason (also found in
    // round 4, by mutation).
    const projDir = join(home, 'project', '.dsh', 'skills', 'proj-skill')
    await mkdir(projDir, { recursive: true })
    await writeFile(join(projDir, 'SKILL.md'), '---\nname: "proj-skill"\ndescription: "project scoped"\n---\n\nproject body\n')
    const projRow = { name: 'proj-skill', description: 'project scoped', resourceBase: { kind: 'directory', path: projDir }, invocation: { modelInvocable: true } }
    const services = fakeServices('```json\n{"action":"nothing"}\n```', { agentSkills: catalogService([projRow]) })
    const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'log-only' }, services)
    const session = { id: 'session-proj', header: {}, deriveMessages: () => [{ role: 'user', content: 'used proj-skill here' }] }
    t.fire(session, completedTurn)
    await new Promise((r) => setTimeout(r, 80))
    const followup = services.created.find((c) => c && c.content)
    const prompt = followup.content[0].text
    assert.ok(!prompt.includes('### suspect:'), 'project-level skill must not be injected as a suspect (patch would be guaranteed patch-missing)')
    // Assert the CATALOG LINE, not the bare name: the transcript above already
    // contains "proj-skill", so `prompt.includes('proj-skill')` held even with the
    // catalog text removed from the prompt, and proved nothing about listing
    // (raised in review round 5). The catalog renders as `- <name>: <description>`.
    assert.ok(
      prompt.includes('- proj-skill: project scoped'),
      'the catalog line must still list the project skill while its body is not injected',
    )
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('review fix: the catalog is read through the review agent ctx, not the plugin ctx', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-catalog-scope-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
  // The regression this pins: a plugin's injected `ctx.skills` resolves to the
  // registry of its own include subtree, which holds only sibling runtime
  // registrations (3 rows on this host) and none of the filesystem provider's
  // user skills (426 in the router's index). Reading through the plugin ctx
  // therefore produced a catalog of 1 in every one of 92 recorded reviews, so
  // ranking had nothing to rank and no suspect ever received a baseHash.
  //
  // The two services are deliberately different here, and the assertions name
  // the full set: an implementation that reads the plugin ctx fails on the row
  // count, not merely on a label.
  const fullCatalog = Array.from({ length: 40 }, (_, i) => ({
    name: `full-skill-${i}`,
    description: `skill number ${i} about deploys and rollbacks`,
    invocation: { modelInvocable: true },
  }))
  let scopedOptions
  const agentSkills = {
    snapshot: async (opts) => { scopedOptions = opts; return { skills: fullCatalog, complete: true } },
  }
  const services = fakeServices('```json\n{"action":"nothing","rationale":"r"}\n```', { agentSkills })
  // The plugin-scoped service answers with a single sibling registration, as the
  // real host does. Anything reading this one is reading the partial view.
  services.skills = {
    snapshot: async () => ({ skills: [{ name: 'sibling-only', description: 'a sibling runtime registration', invocation: { modelInvocable: true } }], complete: true }),
  }
  const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'log-only' }, services)
  const session = { id: 'session-catalog-scope', header: {}, deriveMessages: () => [{ role: 'user', content: 'we deployed today' }] }
  t.fire(session, completedTurn)
  await new Promise((r) => setTimeout(r, 120))

  const followup = services.created.find((c) => c && c.content)
  assert.ok(followup, 'the review must reach the model with a prompt')
  const prompt = followup.content[0].text
  assert.ok(prompt.includes('full-skill-39'), 'the prompt must carry the agent-scoped catalog, not the plugin-scoped one')
  assert.ok(!prompt.includes('sibling-only'), 'the partial sibling view must not be the catalog the review sees')

  // The scope must be the agent itself: `scope` selects the viewing agent's
  // layers, and `ScopeKey` is an identity-compared object, so only the agent
  // yields the session's own catalog.
  assert.ok(scopedOptions, 'the agent-scoped service must be called')
  assert.equal(scopedOptions.scope, services.agent, 'the snapshot must be scoped to the review agent')

  // And the ledger must record which registry answered, so a partial view can
  // never again look like a small library.
  const ledger = (await readFile(join(home, 'hermes-loop', 'activity.jsonl'), 'utf8'))
    .trim().split('\n').map((l) => JSON.parse(l))
  const inputs = ledger.find((e) => e.event === 'review-inputs')
  assert.equal(inputs.catalogSize, 40, 'the traced catalog size must be the agent-scoped row count')
  assert.equal(inputs.catalogVia, 'agent-ctx', 'the trace must name the registry that answered')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('review fix: the agent-scoped catalog is used, and the scope passed is the agent', async () => {
  // The single route: `agent.ctx.get('skills')`, which the host guarantees is the
  // same context `setup` received. This asserts the full catalog reaches the
  // prompt AND that `scope` is the agent itself, since `scope` selects the
  // viewing agent's layers and ScopeKey is an identity-compared object.
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-catalog-setup-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const fullCatalog = Array.from({ length: 12 }, (_, i) => ({
      name: `setup-skill-${i}`,
      description: `skill ${i} about deploys`,
      invocation: { modelInvocable: true },
    }))
    let scopedOptions
    const agentSkills = {
      snapshot: async (opts) => { scopedOptions = opts; return { skills: fullCatalog, complete: true } },
    }
    const services = fakeServices('```json\n{"action":"nothing","rationale":"r"}\n```', { agentSkills })
    services.skills = {
      snapshot: async () => ({ skills: [{ name: 'sibling-only', description: 'partial', invocation: { modelInvocable: true } }], complete: true }),
    }
    const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'log-only' }, services)
    const session = { id: 'session-catalog-setup', header: {}, deriveMessages: () => [{ role: 'user', content: 'deploy' }] }
    t.fire(session, completedTurn)
    await new Promise((r) => setTimeout(r, 120))
    const prompt = services.created.find((c) => c && c.content).content[0].text
    assert.ok(prompt.includes('setup-skill-11'), 'the agent-scoped service must supply the catalog')
    assert.ok(!prompt.includes('sibling-only'), 'the partial view must not be used')
    assert.equal(scopedOptions.scope, services.agent, 'the snapshot must be scoped to the review agent')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('review fix: the plugin-ctx fallback withholds a skill conclusion but keeps memory', async () => {
  // The fallback read is the sibling-only registry, and it reports
  // `complete: true` because every provider it asked answered in full. `complete`
  // therefore cannot catch it, and a create from that catalog can add a duplicate
  // of a skill the partial view never listed. The skill half must be withheld;
  // memory does not read the catalog and must still land.
  //
  // This replaces an earlier test that modelled two different contexts (setup
  // blind, agent.ctx aware). The host has ONE context: `setupAndPublish` calls
  // `setup?.(prepared.agent.ctx, prepared.agent)` and `publish` returns that same
  // agent, so that state is unreachable and the lookup it exercised was
  // redundant (both found in review round 2).
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-catalog-fallback-skill-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await mkdir(join(home, 'hermes-loop'), { recursive: true })
    const conclusion = JSON.stringify({
      action: 'create', skill: 'duplicate-maybe', description: 'd', body: '# b', rationale: 'r',
      memory: { action: 'add', store: 'memory', text: 'the port is 3080', rationale: 'r' },
    })
    // No agent-scoped service at all, so the read falls back to the plugin ctx.
    const services = fakeServices('```json\n' + conclusion + '\n```')
    services.skills = {
      snapshot: async () => ({ skills: [{ name: 'sibling-only', description: 'partial', invocation: { modelInvocable: true } }], complete: true }),
    }
    const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, services)
    const session = { id: 'session-fallback-skill', header: {}, deriveMessages: () => [{ role: 'user', content: 'deploy' }] }
    t.fire(session, completedTurn)
    await new Promise((r) => setTimeout(r, 150))

    let wrote = true
    try { await readFile(join(home, 'skills', 'duplicate-maybe', 'SKILL.md'), 'utf8') } catch { wrote = false }
    assert.equal(wrote, false, 'a partial catalog must not be trusted to create a skill')

    const mem = await readFile(join(home, 'memory', 'MEMORY.md'), 'utf8')
    assert.match(mem, /the port is 3080/, 'the memory channel must survive a partial catalog')

    const ledger = (await readFile(join(home, 'hermes-loop', 'activity.jsonl'), 'utf8'))
      .trim().split('\n').map((l) => JSON.parse(l))
    const inputs = ledger.find((e) => e.event === 'review-inputs')
    assert.equal(inputs.catalogVia, 'plugin-ctx', 'the trace must name the partial registry')
    assert.equal(inputs.catalogShorted, true, 'the trace must flag the catalog as short')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('review fix: an incomplete catalog withholds a skill conclusion but keeps memory', async () => {
  // `complete: false` means a provider threw or returned a partial observation,
  // so the catalog may be missing the very skill this review should patch. The
  // skill conclusion must be withheld; the memory channel does not read the
  // catalog and must still land.
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-catalog-incomplete-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await mkdir(join(home, 'hermes-loop'), { recursive: true })
    const conclusion = JSON.stringify({
      action: 'create', skill: 'should-not-land', description: 'd', body: '# b',
      rationale: 'r',
      memory: { action: 'add', store: 'memory', text: 'the port is 3080', rationale: 'r' },
    })
    const services = fakeServices('```json\n' + conclusion + '\n```', {
      // Agent-scoped AND explicitly incomplete, so `catalogVia` is 'agent-ctx'
      // and `complete: false` is the ONLY reason the catalog counts as short.
      // Routing this through the plugin ctx instead would make the assertion
      // pass on the `plugin-ctx` arm alone, leaving `complete` untested (found
      // in review round 3).
      agentSkills: catalogService([{ name: 'partial-skill', description: 'd', invocation: { modelInvocable: true } }], false),
    })
    // The plugin ctx answers with a COMPLETE catalogue, so if the agent-scoped
    // read were skipped the guard would not fire and the skill would be written.
    services.skills = {
      snapshot: async () => ({ skills: [], complete: true }),
    }
    const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, services)
    const session = { id: 'session-incomplete', header: {}, deriveMessages: () => [{ role: 'user', content: 'deploy' }] }
    t.fire(session, completedTurn)
    await new Promise((r) => setTimeout(r, 150))

    // The skill must not be written.
    let wrote = true
    try { await readFile(join(home, 'skills', 'should-not-land', 'SKILL.md'), 'utf8') } catch { wrote = false }
    assert.equal(wrote, false, 'an incomplete catalog must withhold the skill conclusion')

    // The memory channel is independent and must still have run.
    const mem = await readFile(join(home, 'memory', 'MEMORY.md'), 'utf8')
    assert.match(mem, /the port is 3080/, 'the memory channel must survive an incomplete catalog')

    const ledger = (await readFile(join(home, 'hermes-loop', 'activity.jsonl'), 'utf8'))
      .trim().split('\n').map((l) => JSON.parse(l))
    const inputs = ledger.find((e) => e.event === 'review-inputs')
    assert.equal(inputs.catalogVia, 'agent-ctx', 'this case must exercise the agent-scoped route')
    assert.equal(inputs.catalogComplete, false, 'the snapshot itself must report incomplete')
    assert.equal(inputs.catalogShorted, true, 'the trace must flag the short catalog')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('review fix: a host with no agent-scoped skills service falls back and says so', async () => {
  // The fallback keeps a review running on a host that exposes no scoped
  // context, but the read is the partial one. The trace must name it, because a
  // blind catalog that looks like a small library is the defect this whole
  // change exists to make visible.
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-catalog-fallback-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const services = fakeServices('```json\n{"action":"nothing","rationale":"r"}\n```')
    // No agentSkills supplied, so the context exists but carries no skills
    // service: the host's real no-service shape. Do NOT delete `agent.ctx`; a
    // context-less agent is a state the host does not produce.
    services.skills = {
      snapshot: async () => ({ skills: [{ name: 'only-skill', description: 'partial', invocation: { modelInvocable: true } }], complete: true }),
    }
    const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'log-only' }, services)
    const session = { id: 'session-catalog-fallback', header: {}, deriveMessages: () => [{ role: 'user', content: 'hi' }] }
    t.fire(session, completedTurn)
    await new Promise((r) => setTimeout(r, 120))
    const ledger = (await readFile(join(home, 'hermes-loop', 'activity.jsonl'), 'utf8'))
      .trim().split('\n').map((l) => JSON.parse(l))
    const inputs = ledger.find((e) => e.event === 'review-inputs')
    assert.equal(inputs.catalogSize, 1, 'the fallback keeps the review running')
    assert.equal(inputs.catalogVia, 'plugin-ctx', 'the trace must name the partial registry, not hide it')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('review fix: usage.json load merges with in-memory increments instead of clobbering', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-merge-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await mkdir(join(home, 'hermes-loop'), { recursive: true })
    await writeFile(join(home, 'hermes-loop', 'usage.json'), JSON.stringify({
      savedAt: 'x',
      usage: { 'merge-skill': { count: 7, lastUsedAt: '2026-08-01T00:00:00.000Z' } },
      catalog: {},
    }))
    const services = fakeServices('```json\n{"action":"nothing"}\n```')
    const t = setupPlugin({ turnInterval: 999, mode: 'log-only' }, services)
    const session = { id: 'session-merge', header: {}, deriveMessages: () => [] }
    // 加载 resolve 之前就可能到达的事件（竞态窗口）
    t.fire(session, { type: 'tool/call', data: { name: 'skill', arguments: JSON.stringify({ name: 'merge-skill' }) } })
    await new Promise((r) => setTimeout(r, 60))
    const res = fakeRes()
    await t.routes[0].handler({ method: 'GET', url: '/api/hermes-loop/status?sessionId=' }, res)
    assert.equal(JSON.parse(res.body).usage.rows.find((r) => r.skill === 'merge-skill').count, 8,
      'in-memory increment during the load window must survive the disk load')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('review fix: two same-tick thresholds never run concurrently (serial invariant)', async () => {
  const services = fakeServices('```json\n{"action":"nothing"}\n```')
  let inFlight = 0
  let maxInFlight = 0
  let gate
  const hold = new Promise((r) => { gate = r })
  let created = 0
  services.agents.create = async () => {
    created += 1
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    return {
      agent: {
        session: { seq: 0, events: [{ seq: 1, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '{"action":"nothing"}' }] } } }] },
        followup() {},
        whenIdle: () => (created === 1 ? hold : Promise.resolve()), // 第一个复盘吊住
        cancel() {},
      },
      dispose: async () => { inFlight -= 1 },
    }
  }
  const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'log-only' }, services)
  const s1 = { id: 'session-serial-1', header: {}, deriveMessages: () => [] }
  const s2 = { id: 'session-serial-2', header: {}, deriveMessages: () => [] }
  // 同一同步调用栈连发两个阈值命中——微任务间隙曾是串行不变量的破口
  t.fire(s1, completedTurn)
  t.fire(s2, completedTurn)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(created, 1, 'second review must queue, not start')
  assert.equal(maxInFlight, 1)
  gate() // 放行第一个 → drainNext 接力第二个
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(created, 2, 'queued review runs after the first finishes')
  assert.equal(maxInFlight, 1, 'never concurrent')
})

test('review fix: settings fallback path validates instead of raw Object.assign', async () => {
  const { sanitizeSettingsPatch } = plugin.__internals
  assert.deepEqual(sanitizeSettingsPatch({ mode: 'typo', turnInterval: 0, cooldownMinutes: -5 }), {})
  assert.deepEqual(sanitizeSettingsPatch({ mode: 'approval', turnInterval: 3 }), { mode: 'approval', turnInterval: 3 })
  // 路由级：无 settings scope 时非法 patch 不生效
  const services = fakeServices('```json\n{"action":"nothing"}\n```')
  const t = setupPlugin({}, services) // settings: undefined → 回退路径
  await new Promise((r) => setTimeout(r, 30))
  const res = fakeRes()
  await t.routes[0].handler(postJson('/api/hermes-loop/settings', { patch: { mode: 'typo', cooldownMinutes: -1 } }), res)
  const body = JSON.parse(res.body)
  assert.equal(res.statusCode, 200)
  assert.equal(body.settings.mode, 'auto', 'invalid mode must not fall into the auto write branch silently')
  assert.equal(body.settings.cooldownMinutes, 30, 'out-of-range numbers rejected')
})

test('review fix: overlong description is truncated, not dropped (fail-closed stays for body)', () => {
  const c = parseConclusion(JSON.stringify({ action: 'create', skill: 'long-desc', description: 'x'.repeat(600), body: 'b' }))
  assert.ok(c, 'conclusion survives an overlong description')
  assert.equal(c.description.length, 500)
  assert.equal(parseConclusion(JSON.stringify({ action: 'create', skill: 'x', description: 'd', body: 'y'.repeat(129 * 1024) })), undefined, 'oversized body still fail-closed')
})

// ── Memory 通道（design §12，v0.5）──────────────────────────────────────

const {
  parseMemoryEntries, serializeMemoryEntries, planMemoryChange, scanMemoryEntry,
  applyMemoryConclusion, renderMemoryContext, memoryStoreFile,
} = plugin.__internals

test('memory store: parse/serialize round-trips § entries, ignores noise, flattens newlines', () => {
  const raw = '# MEMORY\n\n§ first entry\nsome handwritten note\n\n§ second entry\n'
  assert.deepEqual(parseMemoryEntries(raw), ['first entry', 'second entry'])
  assert.equal(serializeMemoryEntries('memory', ['a', 'b']), '# MEMORY\n\n§ a\n§ b\n')
  assert.equal(serializeMemoryEntries('user', []), '# USER\n\n')
  // 条目内换行折叠成空格：格式钉死一行一条
  assert.equal(parseMemoryEntries(serializeMemoryEntries('memory', ['x\ny']))[0], 'x y')
})

test('memory scan rejects invisible unicode, control chars and credential patterns', () => {
  assert.equal(scanMemoryEntry('normal entry about deploys'), null)
  assert.equal(scanMemoryEntry('has\u200Bzero-width'), 'invisible-unicode')
  assert.equal(scanMemoryEntry('bad\u0007bell'), 'control-char')
  assert.equal(scanMemoryEntry('the key is sk-abcdefghijklmnop123456 ok'), 'credential-pattern')
  assert.equal(scanMemoryEntry('password=hunter2'), 'credential-pattern')
})

test('planMemoryChange: add appends; duplicate / scan / over-limit rejections (§12.4 ①②③)', () => {
  const base = ['existing entry']
  const ok = planMemoryChange(base, { action: 'add', text: 'fresh fact' }, { limit: 2200 })
  assert.equal(ok.ok, true)
  assert.equal(ok.result, 'added')
  assert.deepEqual(ok.entries, ['existing entry', 'fresh fact'])
  // ① 去重——规范化空白后相同即拒绝
  const dup = planMemoryChange(base, { action: 'add', text: 'existing   entry' }, { limit: 2200 })
  assert.equal(dup.ok, false)
  assert.equal(dup.reason, 'duplicate')
  // ② 扫描
  const scanned = planMemoryChange(base, { action: 'add', text: 'tok\u200Ben looks fine' }, { limit: 2200 })
  assert.equal(scanned.ok, false)
  assert.equal(scanned.reason, 'invisible-unicode')
  // ③ 限额：超限拒绝（不连坐 skill 由 dispatch 通道隔离保证）
  const over = planMemoryChange(base, { action: 'add', text: 'x'.repeat(50) }, { limit: 20 })
  assert.equal(over.ok, false)
  assert.equal(over.reason, 'over-limit')
})

test('planMemoryChange: replace/remove need oldText to hit exactly one entry (§12.4 ④)', () => {
  const base = ['alpha one', 'beta two']
  const rep = planMemoryChange(base, { action: 'replace', oldText: 'beta', text: 'beta three' }, { limit: 2200 })
  assert.equal(rep.ok, true)
  assert.equal(rep.result, 'replaced')
  assert.deepEqual(rep.entries, ['alpha one', 'beta three'])
  const amb = planMemoryChange(base, { action: 'remove', oldText: 'a' }, { limit: 2200 }) // 命中两条
  assert.equal(amb.ok, false)
  assert.equal(amb.reason, 'old-text-ambiguous')
  const miss = planMemoryChange(base, { action: 'remove', oldText: 'gamma' }, { limit: 2200 })
  assert.equal(miss.ok, false)
  assert.equal(miss.reason, 'old-text-missing')
  const rem = planMemoryChange(base, { action: 'remove', oldText: 'alpha one' }, { limit: 2200 })
  assert.equal(rem.ok, true)
  assert.deepEqual(rem.entries, ['beta two'])
})

test('parseConclusion: memory rides along; malformed memory drops without touching the skill conclusion', () => {
  const both = parseConclusion('{"action":"create","skill":"a-b","description":"d","body":"b","memory":{"action":"add","store":"memory","text":"fact","rationale":"r"}}')
  assert.equal(both.memory.action, 'add')
  assert.equal(both.memory.store, 'memory')
  // skill=nothing 但 memory 有效 → memory 保留（通道独立）
  const memOnly = parseConclusion('{"action":"nothing","memory":{"action":"add","store":"user","text":"likes terse answers"}}')
  assert.equal(memOnly.action, 'nothing')
  assert.equal(memOnly.memory.text, 'likes terse answers')
  // 畸形 memory（store 非法）只丢 memory
  const badStore = parseConclusion('{"action":"create","skill":"a-b","description":"d","body":"b","memory":{"action":"add","store":"galaxy","text":"x"}}')
  assert.equal(badStore.memory, undefined)
  // remove 缺 oldText → 丢 memory
  const noOld = parseConclusion('{"action":"nothing","memory":{"action":"remove","store":"memory"}}')
  assert.equal(noOld.memory, undefined)
  // 无 memory 字段 → undefined
  assert.equal(parseConclusion('{"action":"nothing"}').memory, undefined)
  // 超长 text 截断到 500（description 截断同款纪律）
  const long = parseConclusion('{"action":"nothing","memory":{"action":"add","store":"memory","text":"' + 'x'.repeat(600) + '"}}')
  assert.equal(long.memory.text.length, 500)
})

test('renderMemoryContext renders per-store usage; empty stores / all-disabled yield empty string', () => {
  const eff = { memoryEnabled: true, userProfileEnabled: true, memoryCharLimit: 2200, userCharLimit: 1375 }
  const readRaw = (store) => (store === 'memory' ? '# MEMORY\n\n§ fact one\n§ fact two\n' : '')
  const out = renderMemoryContext(eff, readRaw)
  assert.match(out, /长期记忆/)
  assert.match(out, /MEMORY（环境\/项目事实\/约定\/教训） — 16\/2200 字符 · 2 条/)
  assert.match(out, /§ fact one/)
  assert.doesNotMatch(out, /USER（用户画像/) // 空库整节不出现
  assert.equal(renderMemoryContext({ ...eff, memoryEnabled: false, userProfileEnabled: false }, readRaw), '')
  assert.equal(renderMemoryContext(eff, () => ''), '')
})

test('applyMemoryConclusion: add/dup/replace/remove land in dir; store-disabled short-circuits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-loop-mem-'))
  try {
    const limits = { memory: 2200, user: 1375 }
    const enabled = { memory: true, user: false }
    const add = await applyMemoryConclusion({ action: 'add', store: 'memory', text: 'publish needs otp' }, { dir, limits, enabled })
    assert.equal(add.result, 'added')
    assert.equal(add.entries, 1)
    assert.match(await readFile(join(dir, 'MEMORY.md'), 'utf8'), /^# MEMORY\n\n§ publish needs otp\n$/)
    const dup = await applyMemoryConclusion({ action: 'add', store: 'memory', text: 'publish needs otp' }, { dir, limits, enabled })
    assert.equal(dup.result, 'rejected')
    assert.equal(dup.reason, 'duplicate')
    const rep = await applyMemoryConclusion({ action: 'replace', store: 'memory', oldText: 'publish needs otp', text: 'publish must use otp' }, { dir, limits, enabled })
    assert.equal(rep.result, 'replaced')
    assert.match(await readFile(join(dir, 'MEMORY.md'), 'utf8'), /publish must use otp/)
    const dis = await applyMemoryConclusion({ action: 'add', store: 'user', text: 'x' }, { dir, limits, enabled })
    assert.equal(dis.result, 'store-disabled')
    const over = await applyMemoryConclusion({ action: 'add', store: 'memory', text: 'y'.repeat(3000) }, { dir, limits, enabled })
    assert.equal(over.result, 'rejected')
    assert.equal(over.reason, 'over-limit')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('memory context: session-frozen snapshots (Hermes semantics) — mid-session writes only visible to new sessions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-memctx-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const contexts = []
    const sections = []
    const services = fakeServices('```json\n{"action":"nothing"}\n```')
    services.systemPrompt = { section: (s) => sections.push(s), context: (c) => contexts.push(c) }
    setupPlugin({ turnInterval: 999 }, services)
    const memCtx = contexts.find((c) => c.name === 'hermes:memory')
    assert.ok(memCtx, 'hermes:memory context registered')
    assert.equal(typeof memCtx.text, 'function')
    await mkdir(join(home, 'memory'), { recursive: true })
    // 无 scope 的调用（非常规/旧路径）：现算不冻结
    assert.equal(memCtx.text(), '')
    // ── 会话首冻结（§12.2，Hermes 语义）：scope 即 agent 对象，一会话一快照 ──
    await writeFile(join(home, 'memory', 'MEMORY.md'), '# MEMORY\n\n§ durable fact\n')
    const scopeA = { tag: 'session-A' }
    assert.match(memCtx.text({ scope: scopeA }), /§ durable fact/)
    // 会话中途写入：scopeA 冻结在开局快照，看不到新条目
    await writeFile(join(home, 'memory', 'MEMORY.md'), '# MEMORY\n\n§ durable fact\n§ second fact\n')
    assert.doesNotMatch(memCtx.text({ scope: scopeA }), /second fact/, 'frozen snapshot ignores mid-session writes')
    // 下个会话（新 scope）读到的才是新内容
    assert.match(memCtx.text({ scope: { tag: 'session-B' } }), /§ second fact/)
    // 空快照同样冻结：开局空库的会话不会因中途写入突然出现记忆
    const scopeC = { tag: 'session-C' }
    await rm(join(home, 'memory', 'MEMORY.md'))
    assert.equal(memCtx.text({ scope: scopeC }), '')
    await writeFile(join(home, 'memory', 'MEMORY.md'), '# MEMORY\n\n§ late fact\n')
    assert.equal(memCtx.text({ scope: scopeC }), '', 'empty snapshot stays frozen for the whole session')
    // 读盘故障（EISDIR）：该会话以空快照冻结，绝不抛
    await rm(join(home, 'memory', 'MEMORY.md'))
    await mkdir(join(home, 'memory', 'MEMORY.md'))
    assert.equal(memCtx.text({ scope: { tag: 'session-D' } }), '')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

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

test('e2e: an English preference puts English copy in the prompt the model receives', async () => {
  // The review prompt is assembled by the runner, so its language can only be
  // checked here rather than against the dictionaries. Asserting on a source-text
  // match for the runner's call is defeated by a comment holding the same string
  // and is blind to the resolved language, so this drives the real pipeline:
  // mount a locale-bearing settings service, force the transcript past its
  // truncation limit, and read the prompt that is actually sent.
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-i18n-e2e-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const services = fakeServices('```json\n{"action":"nothing","rationale":"nothing worth keeping"}\n```')
  services.settings = {
    describe: () => [
      { ns: 'hermes-loop', value: {} },
      { ns: 'locale', value: { preference: 'en' } },
    ],
    update: async () => {},
  }
  const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, services)
  // Enough messages to exceed DEFAULTS.maxTranscriptChars, so the truncation
  // marker is actually emitted rather than skipped.
  const many = Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: `turn ${i} ` + 'm'.repeat(380) }))
  const session = {
    id: 'session-i18n-e2e',
    header: {},
    deriveMessages: () => many,
    append: () => {},
  }
  try {
    t.fire(session, completedTurn)
    await new Promise((r) => setTimeout(r, 90))
    const followup = services.created.find((c) => c && c.content)
    assert.ok(followup, 'the review agent must have been sent a prompt')
    const prompt = followup.content[0].text
    assert.match(prompt, /You are the background review agent/, 'the English review prompt was sent')
    assert.match(prompt, /## Session transcript \(tail-preserving truncation\)/, 'the English transcript heading was sent')
    assert.match(prompt, /…\(earlier messages dropped; tail kept\)/, 'the English truncation marker was sent')
    // The artifact language, not just the protocol's own copy: this is the line
    // whose absence let an `en` preference produce a fully Chinese skill.
    assert.ok(prompt.includes(plugin.__internals.REVIEW_LANGUAGE_DIRECTIVE.en),
      'the English prompt must pin the description/body language to English')
    assert.ok(!/[\u3000-\u303f\uff00-\uffef\u4e00-\u9fff]/.test(prompt),
      'no CJK or full-width punctuation may reach an English prompt')
  } finally {
    for (const fn of t.cleanups) { try { fn() } catch {} }
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    // The activity journal is written fire-and-forget (mkdir → appendFile, not
    // awaited at the call site). A write armed during the review can land while
    // rm() is tearing the temp home down, recreating `<home>/hermes-loop/` and
    // surfacing ENOTEMPTY. Retry a few times on that race; anything else rethrows.
    for (let attempt = 0; ; attempt++) {
      try { await rm(home, { recursive: true, force: true }); break }
      catch (e) { if (e.code !== 'ENOTEMPTY' || attempt >= 4) throw e; await new Promise((r) => setTimeout(r, 25)) }
    }
  }
})

test('memory e2e: skill=nothing with memory add writes USER.md, echoes a notice, injects entries into the review prompt', async () => {
  const conclusion = JSON.stringify({ action: 'nothing', rationale: 'no skill this time', memory: { action: 'add', store: 'user', text: 'user prefers terse answers', rationale: 'said 直接给答案' } })
  const { home, oldHome, notices, followup } = await runE2E({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, conclusion)
  try {
    assert.match(await readFile(join(home, 'memory', 'USER.md'), 'utf8'), /§ user prefers terse answers/)
    assert.ok(notices.some((n) => n.source && n.source.form === 'notice' && n.source.summary.includes('记忆')), notices.map((n) => n.source && n.source.summary).join('|'))
    assert.ok(notices.some((n) => n.source.summary.includes('下个会话生效')), 'echo must state next-session semantics')
    // 当前记忆条目注入 review prompt（oldText 定位与去重的基准）+ 记忆规则段（按需产出）
    assert.ok(JSON.stringify(followup).includes('当前记忆条目'))
    assert.ok(JSON.stringify(followup).includes('多数复盘应该没有记忆'))
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('memory e2e: combined conclusion writes skill AND memory; guards only reject their own channel', async () => {
  const conclusion = JSON.stringify({
    action: 'create', skill: 'mem-e2e-skill', description: 'has both channels', body: 'body here',
    memory: { action: 'add', store: 'memory', text: 'deploy needs otp' },
  })
  const { home, oldHome } = await runE2E({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, conclusion)
  try {
    assert.match(await readFile(join(home, 'skills', 'mem-e2e-skill', 'SKILL.md'), 'utf8'), /body here/)
    assert.match(await readFile(join(home, 'memory', 'MEMORY.md'), 'utf8'), /§ deploy needs otp/)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('memory e2e: log-only logs the memory conclusion without touching disk; approval stages a pending JSON', async () => {
  const mkConclusion = () => JSON.stringify({ action: 'nothing', memory: { action: 'add', store: 'memory', text: 'web runs on 19080' } })
  // log-only
  {
    const { home, oldHome, t } = await runE2E({ turnInterval: 1, cooldownMinutes: 0, mode: 'log-only' }, mkConclusion())
    try {
      assert.ok(t.infos.some((m) => m.includes('log-only') && m.includes('memory')), t.infos.join('|'))
      let absent = false
      try { await readFile(join(home, 'memory', 'MEMORY.md'), 'utf8') } catch { absent = true }
      assert.ok(absent, 'log-only must not write memory files')
    } finally {
      if (oldHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = oldHome
      await rm(home, { recursive: true, force: true })
    }
  }
  // approval：纯记忆结论也有稳定 pending 标识与 memoryDir 提示
  {
    const { home, oldHome } = await runE2E({ turnInterval: 1, cooldownMinutes: 0, mode: 'approval' }, mkConclusion())
    try {
      const { readdir } = await import('node:fs/promises')
      const staged = await readdir(join(home, 'hermes-loop', 'pending'))
      assert.equal(staged.length, 1)
      assert.match(staged[0], /-memory-memory\.json$/)  // `${ts36}-memory-${store}` 后缀
      const payload = JSON.parse(await readFile(join(home, 'hermes-loop', 'pending', staged[0]), 'utf8'))
      assert.equal(payload.memoryDir, join(home, 'memory'))
      assert.equal(payload.conclusion.memory.text, 'web runs on 19080')
    } finally {
      if (oldHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = oldHome
      await rm(home, { recursive: true, force: true })
    }
  }
})

test('GET status exposes memory stores (enabled/chars/limit/entries) and the last memory outcome', async () => {
  const conclusion = JSON.stringify({ action: 'nothing', memory: { action: 'add', store: 'memory', text: 'fact for status' } })
  const { home, oldHome, t } = await runE2E({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, conclusion)
  try {
    const route = t.routes[0]
    const res = fakeRes()
    await route.handler({ method: 'GET', url: '/api/hermes-loop/status' }, res)
    const body = JSON.parse(res.body)
    assert.equal(res.statusCode, 200)
    assert.ok(body.memory && body.memory.stores)
    const mem = body.memory.stores.memory
    assert.equal(mem.enabled, true)
    assert.equal(mem.chars, 'fact for status'.length)
    assert.equal(mem.limit, 2200)
    assert.equal(mem.entries, 1)
    assert.ok(mem.lastWriteAt, 'lastWriteAt fed from the memory-outcome audit record')
    assert.equal(body.memory.stores.user.entries, 0)
    assert.equal(body.memory.lastOutcome.result, 'added')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('v0.5 追加：默认纠正词表含「记住,记忆」持久化意图词，不含「总结」', () => {
  const words = plugin.__internals.parseCorrectionWords(DEFAULTS.signalCorrectionWords)
  assert.ok(words.includes('记住') && words.includes('记忆'))
  assert.ok(!words.includes('总结'), '总结 too common — deliberately excluded')
  assert.ok(!words.includes('wrong ') && words.includes('wrong'))
})

test('v0.5 追加：默认词表下「记住：X」命中信号提前复盘，「总结一下」不触发', async () => {
  const fire1 = countingServices()
  const t1 = setupPlugin({ turnInterval: 999, toolCallInterval: 999, cooldownMinutes: 0, mode: 'log-only' }, fire1.services)
  const s = { id: 'session-remember', header: {}, deriveMessages: () => [] }
  // 不传 signalCorrectionWords → 用 DEFAULTS（含记住/记忆）
  t1.fire(s, { type: 'user/message', data: { content: [{ type: 'text', text: '帮我记住：web 跑在 19080' }], source: { kind: 'user' } } })
  t1.fire(s, completedTurn)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(fire1.counter.reviews, 1, '记住 in default word list accelerates the review')
  t1.fire(s, { type: 'user/message', data: { content: [{ type: 'text', text: '总结一下这段代码' }], source: { kind: 'user' } } })
  t1.fire(s, completedTurn)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(fire1.counter.reviews, 1, '总结 stays out of the default list; cooldown would gate anyway')

  const fire2 = countingServices()
  const t2 = setupPlugin({ turnInterval: 999, toolCallInterval: 999, cooldownMinutes: 0, mode: 'log-only', signalCorrectionWords: '不对,错了' }, fire2.services)
  t2.fire(s, { type: 'user/message', data: { content: [{ type: 'text', text: '记住这个' }], source: { kind: 'user' } } })
  t2.fire(s, completedTurn)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(fire2.counter.reviews, 0, 'user-overridden word list replaces the defaults entirely')
})

test('v0.5 追加：status 的 memory.items 带只读条目原文', async () => {
  const conclusion = JSON.stringify({ action: 'nothing', memory: { action: 'add', store: 'memory', text: 'fact for items' } })
  const { home, oldHome, t } = await runE2E({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, conclusion)
  try {
    const route = t.routes[0]
    const res = fakeRes()
    await route.handler({ method: 'GET', url: '/api/hermes-loop/status' }, res)
    const body = JSON.parse(res.body)
    assert.deepEqual(body.memory.stores.memory.items, ['fact for items'])
    assert.deepEqual(body.memory.stores.user.items, [])
    assert.equal(body.memory.stores.memory.entries, 1) // entries 仍是计数
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

// ── 审查修复（2026-10-07）：scope 必须挂过 preset，且空目录不等于健康 ──────

test('review fix: the session agent is read before the review agent, because only it joined a preset', async () => {
  // The defect this pins: reading through an agent context is necessary but NOT
  // sufficient. `snapshot({ scope })` merges the global layer plus the scope
  // CHAIN, and the host links an agent's scope to a preset generation only by
  // calling `presets.mount(agentCtx, presetId)` inside `setup`
  // (dsh-api-session-controller/lib/index.js:368). The triggering session's agent
  // is the one the host composed; the review agent this plugin creates itself
  // never mounts, so its chain holds no filesystem provider. On the live host
  // that read is genuinely scoped, genuinely `complete: true`, and returns ONE
  // runtime row.
  //
  // So the two agents must disagree here, and the assertions name the full set:
  // an implementation that reads the review agent first fails on the prompt
  // contents, not merely on a label.
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-session-agent-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const sessionCatalog = Array.from({ length: 9 }, (_, i) => provided({
      name: `session-skill-${i}`,
      description: `skill ${i} about deploys`,
      invocation: { modelInvocable: true },
    }))
    let sessionScopedOptions
    const sessionAgentSkills = {
      snapshot: async (opts) => { sessionScopedOptions = opts; return { skills: sessionCatalog, complete: true } },
    }
    // The review agent answers with exactly the live shape: one runtime row,
    // complete, no discovery provider behind it.
    const agentSkills = {
      snapshot: async () => ({
        skills: [{ name: 'vision-skills', description: 'a runtime registration', invocation: { modelInvocable: true }, provider: 'runtime' }],
        complete: true,
      }),
    }
    const services = fakeServices('```json\n{"action":"nothing","rationale":"r"}\n```', {
      agentSkills,
      sessionAgent: { id: 'session-priority', session: { seq: 0, events: [] } },
      sessionAgentSkills,
    })
    const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'log-only' }, services)
    const session = { id: 'session-priority', header: {}, deriveMessages: () => [{ role: 'user', content: 'we deployed' }] }
    t.fire(session, completedTurn)
    await new Promise((r) => setTimeout(r, 120))

    const prompt = services.created.find((c) => c && c.content).content[0].text
    assert.ok(prompt.includes('session-skill-8'), 'the session agent catalog must supply the prompt')
    assert.ok(!prompt.includes('vision-skills'), 'the providerless review-agent read must not be the catalog')

    // The scope passed must be that session agent, not the review agent: ScopeKey
    // is identity-compared, so passing the wrong agent reads the wrong layers.
    assert.ok(sessionScopedOptions, 'the session agent service must be called')
    assert.equal(sessionScopedOptions.scope, services.sessionAgent, 'the snapshot must be scoped to the session agent')

    const ledger = (await readFile(join(home, 'hermes-loop', 'activity.jsonl'), 'utf8'))
      .trim().split('\n').map((l) => JSON.parse(l))
    const inputs = ledger.find((e) => e.event === 'review-inputs')
    assert.equal(inputs.catalogSize, 9, 'the traced size must be the session agent row count')
    assert.equal(inputs.catalogScope, 'session-agent', 'the trace must name which scope answered')
    assert.equal(inputs.catalogShorted, false, 'a provider-backed catalog is not short')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('review fix: a non-empty catalog with no discovery provider withholds the skill conclusion', async () => {
  // The arm that catches the shipped defect. Neither existing signal can see it:
  // the read IS agent-scoped (`via` says so) and every provider it asked answered
  // in full (`complete: true`). The only evidence left is that the rows came back
  // stamped `runtime`, meaning no discovery provider was reachable from the scope
  // that was read. A create drawn from such a catalog can duplicate a skill the
  // partial view never listed, so the skill half must be withheld while memory,
  // which does not read the catalog, still lands.
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-providerless-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const conclusion = JSON.stringify({
      action: 'create', skill: 'should-not-land', description: 'd', body: 'b',
      memory: { action: 'add', store: 'memory', text: 'memory still runs' },
    })
    const services = fakeServices('```json\n' + conclusion + '\n```', {
      agentSkills: {
        snapshot: async () => ({
          skills: [{ name: 'vision-skills', description: 'a runtime registration', invocation: { modelInvocable: true }, provider: 'runtime' }],
          complete: true,
        }),
      },
    })
    const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, services)
    const session = { id: 'session-providerless', header: { cwd: home }, deriveMessages: () => [{ role: 'user', content: 'deploys' }] }
    t.fire(session, completedTurn)
    await new Promise((r) => setTimeout(r, 120))

    await assert.rejects(
      readFile(join(home, 'skills', 'should-not-land', 'SKILL.md'), 'utf8'),
      'a create from a providerless catalog must not be written',
    )
    const ledger = (await readFile(join(home, 'hermes-loop', 'activity.jsonl'), 'utf8'))
      .trim().split('\n').map((l) => JSON.parse(l))
    const inputs = ledger.find((e) => e.event === 'review-inputs')
    assert.equal(inputs.catalogProviderless, true, 'the trace must name the providerless read')
    assert.equal(inputs.catalogShorted, true, 'the trace must flag the catalog as short')
    assert.equal(inputs.catalogVia, 'agent-ctx', 'the read was still agent-scoped, which is why via alone cannot catch it')
    assert.equal(inputs.catalogComplete, true, 'and it still reported complete, which is why complete alone cannot catch it')
    // Memory does not read the catalog, so the other channel still lands.
    assert.ok(t.infos.some((m) => m.includes('memory')), t.infos.join('|'))
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('review fix: an empty catalog is not treated as providerless, so a first create still lands', async () => {
  // Emptiness cannot distinguish "this scope has no provider" from "this library
  // genuinely holds no skills": `collectFresh` leaves `cacheable` true in both and
  // the snapshot API exposes nothing else. Flagging it would make the first create
  // on a fresh install impossible, and with no rows there is no suspect to inject,
  // so no valid baseHash can exist and a patch cannot be produced either. The
  // plugin-scope arm still covers the empty read that IS knowably providerless.
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-empty-catalog-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const conclusion = JSON.stringify({ action: 'create', skill: 'first-skill', description: 'd', body: 'b' })
    const services = fakeServices('```json\n' + conclusion + '\n```', { agentSkills: catalogService([]) })
    const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, services)
    const session = { id: 'session-empty', header: { cwd: home }, deriveMessages: () => [{ role: 'user', content: 'first' }] }
    t.fire(session, completedTurn)
    await new Promise((r) => setTimeout(r, 120))
    assert.match(await readFile(join(home, 'skills', 'first-skill', 'SKILL.md'), 'utf8'), /b/, 'an empty agent-scoped catalog must not block a create')
    const ledger = (await readFile(join(home, 'hermes-loop', 'activity.jsonl'), 'utf8'))
      .trim().split('\n').map((l) => JSON.parse(l))
    const inputs = ledger.find((e) => e.event === 'review-inputs')
    assert.equal(inputs.catalogProviderless, false, 'an empty catalog is not evidence of a missing provider')
    assert.equal(inputs.catalogShorted, false, 'so it must not be flagged short')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

// ── 审查修复（2026-10-07 r3）：结构证据只证「有」，不证「无」 ──────────────

test('review fix: an ACTIVE provider proof makes a suspicious catalog trustworthy, and a named proof cannot short it', async () => {
  // The structural proof is consulted as a POSITIVE only, and this is why.
  //
  // A catalog whose rows are all runtime is the shipped defect WHEN no discovery
  // provider is in scope. But `no-preset` does NOT prove there is no provider: the
  // global layer is always merged (`dsh-skill/lib/index.js:299`), and a host may
  // put the filesystem provider there (`dsh-base/cordis.patch.yml:297` defines such
  // a row; the web bundle disables it in favour of presets). So the proof is used
  // to trust an otherwise-suspicious read, never to condemn one on its own.
  //
  // Case A: runtime-only rows, but the proof is `'active'`: a provider IS in scope,
  // so the create is allowed. This is the case row labels alone would withhold.
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-proof-active-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const conclusion = JSON.stringify({ action: 'create', skill: 'lands-ok', description: 'd', body: 'b' })
    const services = fakeServices('```json\n' + conclusion + '\n```', {
      sessionAgent: { id: 'session-proof-active', session: { seq: 0, events: [] } },
      // A provider is in scope, but it happened to return only this runtime row.
      sessionAgentSkills: catalogService([{ name: 'vision-skills', description: 'd', invocation: { modelInvocable: true }, provider: 'runtime' }]),
      agentSkills: catalogService([{ name: 'vision-skills', description: 'd', invocation: { modelInvocable: true }, provider: 'runtime' }]),
      presets: {},
    })
    const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, services)
    const session = { id: 'session-proof-active', header: { cwd: home }, deriveMessages: () => [{ role: 'user', content: 'x' }] }
    t.fire(session, completedTurn)
    await new Promise((r) => setTimeout(r, 120))
    assert.match(await readFile(join(home, 'skills', 'lands-ok', 'SKILL.md'), 'utf8'), /b/, 'an ACTIVE proof must permit the create')
    const ledger = (await readFile(join(home, 'hermes-loop', 'activity.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    const inputs = ledger.find((e) => e.event === 'review-inputs')
    assert.equal(inputs.catalogProviderProof, 'active', 'the trace must record positive structural proof')
    assert.equal(inputs.catalogProviderless, true, 'the rows are runtime-only, so the row-label arm also fired')
    assert.equal(inputs.catalogShorted, false, 'but the ACTIVE proof overrides it: a provider is in scope')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('review fix: a runtime-only catalog is withheld whenever no active provider proof exists', async () => {
  // The shipped defect, across every non-positive proof verdict. Each of these is
  // a host shape where nothing established that a discovery provider answered the
  // scope, while the rows in hand are all runtime registrations. The skill half
  // must be withheld and memory, which does not read the catalog, must still run.
  for (const [label, presets, expected] of [
    // No preset registry at all: `unprovable`. The live host's own shape today.
    ['unprovable', undefined, 'unprovable'],
    // The agent joined no preset. NOT proof of absence, but combined with
    // runtime-only rows it leaves no evidence a provider answered.
    ['no-preset', { presetId: null }, 'no-preset'],
    // The preset names no skill provider row.
    ['provider-absent', { rows: [] }, 'provider-absent'],
    // The row exists but is disabled, or enabled with no live fiber.
    ['provider-disabled', { rows: [{ entryId: 'skill-filesystem', moduleName: REQUIRED_PROVIDER, enabled: false, fiberState: 2 }] }, 'provider-inactive'],
    ['provider-loading', { rows: [{ entryId: 'skill-filesystem', moduleName: REQUIRED_PROVIDER, enabled: true, fiberState: 1 }] }, 'provider-inactive'],
    ['provider-no-fiber', { rows: [{ entryId: 'skill-filesystem', moduleName: REQUIRED_PROVIDER, enabled: true }] }, 'provider-inactive'],
  ]) {
    const home = await mkdtemp(join(tmpdir(), 'hermes-loop-proof-' + label + '-'))
    const oldHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const conclusion = JSON.stringify({
        action: 'create', skill: 'must-not-land', description: 'd', body: 'b',
        memory: { action: 'add', store: 'memory', text: 'memory still runs' },
      })
      const runtimeOnly = catalogService([{ name: 'vision-skills', description: 'd', invocation: { modelInvocable: true }, provider: 'runtime' }])
      const services = fakeServices('```json\n' + conclusion + '\n```', {
        sessionAgent: { id: 'session-proof-' + label, session: { seq: 0, events: [] } },
        sessionAgentSkills: runtimeOnly,
        agentSkills: runtimeOnly,
        ...(presets === undefined ? {} : { presets }),
      })
      const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, services)
      const session = { id: 'session-proof-' + label, header: { cwd: home }, deriveMessages: () => [{ role: 'user', content: 'x' }] }
      t.fire(session, completedTurn)
      await new Promise((r) => setTimeout(r, 120))

      await assert.rejects(readFile(join(home, 'skills', 'must-not-land', 'SKILL.md'), 'utf8'), label + ': a runtime-only catalog must be withheld')
      const ledger = (await readFile(join(home, 'hermes-loop', 'activity.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
      const inputs = ledger.find((e) => e.event === 'review-inputs')
      assert.equal(inputs.catalogProviderProof, expected, label + ': the trace must name the structural verdict')
      assert.equal(inputs.catalogProviderless, true, label + ': the rows are runtime-only')
      assert.equal(inputs.catalogShorted, true, label + ': so the catalog must be flagged short')
      assert.ok(t.infos.some((m) => m.includes('memory')), label + ': memory does not read the catalog and must still run')
    } finally {
      if (oldHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = oldHome
      await rm(home, { recursive: true, force: true })
    }
  }
})

test('review fix: a provider-backed catalog is allowed without any structural proof', async () => {
  // The other half of the asymmetry. When a discovery provider DID answer, the
  // rows say so and no composition reading is needed, so an ordinary host that
  // exposes no preset registry still works. Without this, the structural arm would
  // turn "cannot prove" into "refuse", breaking every host that lacks the registry.
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-proof-fallback-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const conclusion = JSON.stringify({ action: 'create', skill: 'lands-via-rows', description: 'd', body: 'b' })
    const services = fakeServices('```json\n' + conclusion + '\n```', {
      sessionAgent: { id: 'session-proof-fallback', session: { seq: 0, events: [] } },
      sessionAgentSkills: catalogService([{ name: 'real-skill', description: 'd', invocation: { modelInvocable: true } }]),
      agentSkills: catalogService([{ name: 'real-skill', description: 'd', invocation: { modelInvocable: true } }]),
      // no `presets`: the host exposes no agentPresets service.
    })
    const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, services)
    const session = { id: 'session-proof-fallback', header: { cwd: home }, deriveMessages: () => [{ role: 'user', content: 'x' }] }
    t.fire(session, completedTurn)
    await new Promise((r) => setTimeout(r, 120))
    assert.match(await readFile(join(home, 'skills', 'lands-via-rows', 'SKILL.md'), 'utf8'), /b/, 'a provider-backed catalog must not need structural proof')
    const ledger = (await readFile(join(home, 'hermes-loop', 'activity.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    const inputs = ledger.find((e) => e.event === 'review-inputs')
    assert.equal(inputs.catalogProviderProof, 'unprovable', 'the trace must record that proof was unavailable')
    assert.equal(inputs.catalogProviderless, false, 'because a real provider row answered')
    assert.equal(inputs.catalogShorted, false, 'so the catalog is healthy')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('review fix: an empty catalog is trusted even without a structural proof, so a first create still lands', async () => {
  // A NAMED CEILING, pinned so it is not rediscovered as a bug later. An empty
  // catalog is never flagged by the row-label arm, with or without a proof,
  // because emptiness cannot distinguish a scope whose provider never answered
  // from a library that genuinely holds no skills (`collectFresh` leaves
  // `cacheable` true in both). Refusing there would make the first create on a
  // fresh install impossible, and with no rows there is no suspect to inject, so
  // no `baseHash` can exist and no patch could be produced either. The residual
  // risk is a duplicate create when a provider really did fail to answer; the fix
  // would have to come from a host API that enumerates the providers behind a
  // scoped read, which does not exist.
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-empty-proven-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const conclusion = JSON.stringify({ action: 'create', skill: 'first-skill', description: 'd', body: 'b' })
    const services = fakeServices('```json\n' + conclusion + '\n```', {
      sessionAgent: { id: 'session-empty-proven', session: { seq: 0, events: [] } },
      sessionAgentSkills: catalogService([]),
      agentSkills: catalogService([]),
      presets: {},
    })
    const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, services)
    const session = { id: 'session-empty-proven', header: { cwd: home }, deriveMessages: () => [{ role: 'user', content: 'x' }] }
    t.fire(session, completedTurn)
    await new Promise((r) => setTimeout(r, 120))
    assert.match(await readFile(join(home, 'skills', 'first-skill', 'SKILL.md'), 'utf8'), /b/, 'an empty catalog must allow the first create')
    const ledger = (await readFile(join(home, 'hermes-loop', 'activity.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    const inputs = ledger.find((e) => e.event === 'review-inputs')
    assert.equal(inputs.catalogProviderProof, 'active', 'the trace records the proof when one is available')
    assert.equal(inputs.catalogProviderless, false, 'an empty catalog is never flagged by the row-label arm')
    assert.equal(inputs.catalogShorted, false, 'so the create is allowed')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('providerProofOf never rejects: every malformed host shape degrades to a verdict', async () => {
  // A proof that aborts the review is worse than one that admits it could not
  // tell, because the review then reports an error and drops BOTH channels. Each
  // host-shaped failure below must resolve to a verdict string.
  const { providerProofOf, REQUIRED_SKILL_PROVIDER: req } = plugin.__internals
  const agent = { ctx: { marker: true } }
  const throwingRow = Object.defineProperty({}, 'moduleName', { get() { throw new Error('bad row') } })
  const cases = [
    ['ctx.get throws', { get() { throw new Error('no get') } }, 'unprovable'],
    ['no registry', { get: () => undefined }, 'unprovable'],
    ['registry lacks api', { get: () => ({}) }, 'unprovable'],
    ['composedPreset throws', { get: () => ({ composedPreset() { throw new Error('x') }, compositionInventory: async () => [] }) }, 'unprovable'],
    ['inventory rejects', { get: () => ({ composedPreset: () => 'standard', compositionInventory: async () => { throw new Error('x') } }) }, 'unprovable'],
    ['inventory not an array', { get: () => ({ composedPreset: () => 'standard', compositionInventory: async () => ({}) }) }, 'unprovable'],
    ['preset not found', { get: () => ({ composedPreset: () => 'gone', compositionInventory: async () => [] }) }, 'unprovable'],
    ['rows not an array', { get: () => ({ composedPreset: () => 'standard', compositionInventory: async () => [{ id: 'standard', rows: {} }] }) }, 'unprovable'],
    ['row accessor throws', { get: () => ({ composedPreset: () => 'standard', compositionInventory: async () => [{ id: 'standard', rows: [throwingRow] }] }) }, 'malformed'],
  ]
  for (const [label, ctx, expected] of cases) {
    const verdict = await providerProofOf(ctx, agent)
    assert.equal(verdict, expected, label + ': must degrade, not reject')
  }
})

test('known ceiling: a provider that answers zero rows is indistinguishable from no provider, so it is withheld', async () => {
  // Pinned so it is not rediscovered as a bug. Two situations are byte-identical
  // through every public API:
  //   (a) no discovery provider was reachable (the shipped defect), and
  //   (b) a provider WAS reachable and the library is empty, while a runtime
  //       registration makes the snapshot nonempty.
  // `snapshot()` returns only `{ skills, complete }`
  // (`dsh-skill/lib/types/index.d.ts:152-157`); a provider answering zero rows
  // contributes zero rows, so nothing records that it participated, and no API
  // enumerates the providers behind a scoped read.
  //
  // Withholding is the deliberate direction: a missed first create is recoverable,
  // a duplicate create from a catalog that never listed the matching skill is not.
  // The cost is bounded and self-healing, which the last case shows.
  const { catalogLooksProviderless } = plugin.__internals
  const runtimeRow = { name: 'vision-skills', description: 'd', invocation: { modelInvocable: true }, provider: 'runtime' }

  // (a) and (b) are the same observation.
  assert.equal(catalogLooksProviderless({ skills: [runtimeRow], complete: true }), true, 'runtime rows alone are withheld')

  // A genuinely empty catalog is NOT flagged, so a fresh install is not blocked
  // when a provider is proven active (see the empty-catalog test above).
  assert.equal(catalogLooksProviderless({ skills: [], complete: true }), false, 'emptiness alone is not evidence')

  // Self-healing: one provider-backed row ends the ambiguity for good.
  assert.equal(
    catalogLooksProviderless({ skills: [runtimeRow, { name: 'real', description: 'd', provider: 'filesystem' }], complete: true }),
    false,
    'a single provider-backed row ends the withholding',
  )

  // The structural proof is the only thing that can rescue case (b): when a
  // provider is proven active, the read is trusted even with runtime-only rows.
  const { providerProofIsPositive } = plugin.__internals
  assert.equal(providerProofIsPositive('active'), true, 'an active proof is positive evidence')
  for (const verdict of ['no-preset', 'provider-absent', 'provider-inactive', 'malformed', 'unprovable']) {
    assert.equal(providerProofIsPositive(verdict), false, verdict + ' is not positive evidence')
  }
})
