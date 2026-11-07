/**
 * The review input is the skill router's suggestion block, and a review the
 * router cannot answer is deferred instead of run.
 *
 * These tests drive the real pipeline: a fake host context, the real
 * `session/event` handler, the real review runner, the real activity ledger and
 * the real status route. Nothing here asserts on private helpers, so a rename
 * inside the runner cannot make one pass while the shipped behaviour changes.
 *
 * Timers are mocked with node:test's MockTimers API: the retry is an hour away,
 * and a test that slept for it would never ship.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const plugin = createRequire(import.meta.url)('../src/index.js')

const HOUR_MS = 60 * 60 * 1000
const completedTurn = { type: 'turn/end', data: { reason: { kind: 'completed' } } }

const SUGGESTIONS = [
  { name: 'alpha-skill', description: 'first suggested skill', path: '/skills/alpha-skill/SKILL.md' },
  { name: 'beta-skill', description: 'second suggested skill' },
]
// Exactly what the router's renderer produces for SUGGESTIONS: a caller must
// not reformat it, so the fixture is a literal, not a re-render.
const RENDERED = [
  '- alpha-skill: first suggested skill',
  '  read: /skills/alpha-skill/SKILL.md',
  '- beta-skill: second suggested skill',
].join('\n')

const healthy = () => ({ suggestions: SUGGESTIONS, rendered: RENDERED, degraded: false })
const healthyEmpty = () => ({ suggestions: [], rendered: '', degraded: false })

/**
 * A fake host context. `suggestionService` is what `ctx.get('skillRouterSuggestions')`
 * answers; `undefined` models a host where the router is not mounted.
 */
function fakeHost({ suggestionService, catalog = [], conclusion = '{"action":"nothing","rationale":"nothing to add"}', config = { turnInterval: 1, cooldownMinutes: 0, mode: 'log-only' } } = {}) {
  const created = []
  const followups = []
  const handlers = []
  const cleanups = []
  const infos = []
  const warns = []
  const routes = []
  const sessions = new Map()
  const agent = {
    session: {
      seq: 0,
      snapshotEvents: () => [{
        seq: 1,
        type: 'assistant/message',
        data: { message: { role: 'assistant', content: [{ type: 'text', text: '```json\n' + conclusion + '\n```' }] } },
      }],
    },
    followup(message) { followups.push(message) },
    whenIdle: async () => {},
    cancel() {},
  }
  const ctx = {
    logger: { info: (m) => infos.push(String(m)), warn: (m) => warns.push(String(m)) },
    connection: { requestRejection: () => undefined },
    on: (name, fn) => { handlers.push(fn); return () => {} },
    effect: (fn) => { cleanups.push(fn()) },
    skills: { snapshot: async () => ({ skills: catalog, complete: true }) },
    settings: undefined,
    sessions: { get: (id) => sessions.get(id) },
    // Only the router service is reachable through a dynamic lookup; every
    // other name is absent, which is the host shape a plugin must tolerate.
    get: (name) => (name === 'skillRouterSuggestions' ? suggestionService : undefined),
    agents: {
      create: async (opts) => {
        created.push(opts)
        if (typeof opts.setup === 'function') await opts.setup({ tools: { restrict() {} }, get: () => undefined }, agent)
        return { agent, dispose: async () => {} }
      },
      get: () => undefined,
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'prov', model: 'mdl' }) },
  }
  ctx.inject = (deps, cb) => { if (Array.isArray(deps) && deps.includes('webServer')) cb({ webServer: { register: (route) => routes.push(route) } }) }
  return {
    ctx,
    sessions,
    created,
    followups,
    cleanups,
    infos,
    warns,
    routes,
    fire: (session, event) => { for (const h of handlers) h(session, event) },
    start() { plugin.apply(ctx, config) },
    prompt: () => {
      const message = followups.find((m) => m && m.content)
      return message === undefined ? undefined : message.content[0].text
    },
  }
}

/** Let every already-resolved promise and the fire-and-forget ledger write run. */
async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve))
}

async function ledger(home) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const raw = await readFile(join(home, 'hermes-loop', 'activity.jsonl'), 'utf8')
      return raw.trimEnd().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    } catch { await flush(2) }
  }
  return []
}

/** Poll until the ledger holds an event of this name: tracer writes are fire-and-forget. */
async function waitForEvent(home, name, count = 1) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const events = await ledger(home)
    const found = events.filter((e) => e.event === name)
    if (found.length >= count) return found
    await flush(1)
  }
  return []
}

/** The deferral events of one session, polled: several sessions share one home. */
async function deferralFor(home, sessionId) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const found = (await ledger(home)).filter((e) => e.event === 'review-deferred' && e.sessionId === sessionId)
    if (found.length > 0) return found
    await flush(1)
  }
  return []
}

/** Wait until a predicate holds, yielding to real IO between attempts. */
async function waitFor(predicate, tries = 400) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return true
    await flush(1)
  }
  return predicate()
}

function fakeRes() {
  return {
    status: 0,
    body: undefined,
    writeHead(status) { this.status = status },
    end(payload) { this.body = JSON.parse(payload) },
  }
}

/** The manual-review request the panel sends: POST /api/hermes-loop/review-now. */
function postReviewNow(sessionId) {
  const body = Buffer.from(JSON.stringify({ sessionId }))
  return {
    method: 'POST',
    url: '/api/hermes-loop/review-now',
    on(name, fn) {
      if (name === 'data') fn(body)
      if (name === 'end') fn()
      return this
    },
  }
}

async function statusOf(t, sessionId) {
  const route = t.routes[0]
  assert.ok(route, 'the status route must be registered')
  const res = fakeRes()
  await route.handler({ method: 'GET', url: '/api/hermes-loop/status?sessionId=' + encodeURIComponent(sessionId) }, res)
  return res.body
}

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'hermes-review-router-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    for (let attempt = 0; ; attempt++) {
      try { await rm(home, { recursive: true, force: true }); break } catch (e) {
        if (e.code !== 'ENOTEMPTY' || attempt >= 4) throw e
        await flush(2)
      }
    }
  }
}

/** One live session whose first completed turn is over the threshold. */
function session(id, messages = [{ role: 'user', content: 'we fixed the review prompt budget' }]) {
  return { id, header: {}, deriveMessages: () => messages, append: () => {} }
}

const reviewConfig = { turnInterval: 1, cooldownMinutes: 0, mode: 'log-only' }

test('the prompt carries the router-rendered suggestions and no catalog or skill body', async () => {
  await withHome(async (home) => {
    const body = 'BODY-SENTINEL-' + 'x'.repeat(40)
    await mkdir(join(home, 'skills', 'alpha-skill'), { recursive: true })
    await writeFile(join(home, 'skills', 'alpha-skill', 'SKILL.md'), `---\nname: "alpha-skill"\ndescription: "d"\n---\n\n${body}\n`)
    const service = { query: async () => healthy() }
    const t = fakeHost({ suggestionService: service })
    t.start()
    const live = session('session-suggest')
    t.sessions.set(live.id, live)
    t.fire(live, completedTurn)
    assert.ok(await waitFor(() => t.prompt() !== undefined), 'the review must be sent a prompt')
    const prompt = t.prompt()
    assert.ok(prompt.includes(RENDERED), 'the router-rendered block must reach the prompt verbatim')
    assert.ok(prompt.includes(plugin.__internals.REVIEW_INPUT_TEXT.zh.suggestions), 'the suggestion section must be present')
    assert.ok(!prompt.includes(body), 'no skill body may reach the prompt')
    assert.ok(!prompt.includes('### suspect:'), 'no suspect body block may reach the prompt')
    assert.ok(!prompt.includes('baseHash:'), 'no skill hash may reach the prompt')
    const inputs = (await waitForEvent(home, 'review-inputs'))[0]
    assert.ok(inputs, 'the run must record its inputs')
    assert.equal(inputs.suggestionCount, 2, 'the ledger must record the suggestion count')
    assert.equal(inputs.suggestionChars, RENDERED.length, 'the ledger must record the suggestion block size')
  })
})

test('the huge-library guard is gone: the prompt size tracks the transcript, not the library', async () => {
  await withHome(async (home) => {
    // 40 skills with 7 KiB bodies each, and the same 40 rows in the catalog the
    // old path read: it listed all 40 and injected three bodies, so this prompt
    // was scores of kilobytes. The new path never reads either.
    const catalog = []
    for (let i = 0; i < 40; i++) {
      const dir = join(home, 'skills', `skill-${i}`)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'SKILL.md'), `---\nname: "skill-${i}"\ndescription: "d${i}"\n---\n\n${'z'.repeat(7000)}\n`)
      catalog.push({ name: `skill-${i}`, description: `d${i}`, resourceBase: { kind: 'directory', path: dir }, invocation: { modelInvocable: true }, provider: 'filesystem' })
    }
    const t = fakeHost({ suggestionService: { query: async () => healthyEmpty() }, catalog })
    t.start()
    const live = session('session-size', [{ role: 'user', content: 'short conversation' }])
    t.sessions.set(live.id, live)
    t.fire(live, completedTurn)
    assert.ok(await waitFor(() => t.prompt() !== undefined), 'the review must be sent a prompt')
    const prompt = t.prompt()
    assert.ok(prompt.length < 16 * 1024, `the prompt must stay small; got ${prompt.length} characters`)
    assert.ok(!prompt.includes('zzzz'), 'no library body may reach the prompt')
    assert.ok(!prompt.includes('- skill-0:'), 'no library catalog may reach the prompt')
  })
})

test('a healthy answer with no suggestions still runs and keeps an empty suggestion section', async () => {
  await withHome(async (home) => {
    await mkdir(join(home, 'memory'), { recursive: true })
    await writeFile(join(home, 'memory', 'MEMORY.md'), '§ the service runs on port 19080\n')
    const calls = []
    const t = fakeHost({ suggestionService: { query: async (q) => { calls.push(q); return healthyEmpty() } } })
    t.start()
    const live = session('session-empty')
    t.sessions.set(live.id, live)
    t.fire(live, completedTurn)
    assert.ok(await waitFor(() => t.prompt() !== undefined), 'a healthy empty answer must still send the review prompt')
    const prompt = t.prompt()
    assert.ok(prompt.includes(plugin.__internals.REVIEW_INPUT_TEXT.zh.suggestions), 'the suggestion heading must be present')
    assert.ok(prompt.includes(plugin.__internals.REVIEW_INPUT_TEXT.zh.noSuggestions), 'the empty section must say the router suggested nothing')
    assert.ok(prompt.includes('the service runs on port 19080'), 'the memory channel must still reach the prompt')
    assert.equal(calls.length, 1, 'the service is queried once per run')
    assert.match(calls[0].text, /we fixed the review prompt budget/, 'the query text is the session the review judges')
    assert.deepEqual([...calls[0].alreadySuggested], [], 'a review passes an empty suppression set')
    assert.deepEqual(calls[0].recent, [], 'a review has no turn history to pass as recent context')
  })
})

test('a missing router service defers: no prompt, counters restored, one retry, ledger reason', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withHome(async (home) => {
    let queries = 0
    const host = fakeHost({ suggestionService: undefined })
    host.start()
    // The service is absent, but count lookups to prove the retry never queries.
    const originalGet = host.ctx.get
    host.ctx.get = (name) => { if (name === 'skillRouterSuggestions') queries++; return originalGet(name) }
    const live = session('session-missing')
    host.sessions.set(live.id, live)
    host.fire(live, completedTurn)
    await flush()

    assert.equal(host.prompt(), undefined, 'a deferred run must send no review prompt')
    assert.equal(host.created.length, 0, 'a deferred run must not even create the review agent')
    const deferred = (await waitForEvent(home, 'review-deferred'))[0]
    assert.ok(deferred, 'the deferral must be in the ledger')
    assert.equal(deferred.reason, 'missing-service', 'the ledger must name the reason')
    assert.equal(deferred.sessionId, live.id)

    // The window the run reset on entry is restored: the turn that triggered it
    // still counts, so the session is not made to wait a full interval.
    const status = await statusOf(host, live.id)
    assert.equal(status.current.turns, 1, 'the trigger counters must be restored')
    assert.equal(status.deferred.reason, 'missing-service')
    assert.ok(status.deferred.retryAt, 'the status must carry when the retry runs')
    assert.equal(status.deferredCount, 1, 'exactly one retry may be pending')

    const before = queries
    t.mock.timers.tick(HOUR_MS - 1)
    await flush()
    assert.equal(queries, before, 'the retry must not fire early')
    t.mock.timers.tick(1)
    await flush()
    assert.equal(queries, before + 1, 'the retry must fire after one hour')

    // It deferred again and rescheduled exactly one retry, not two.
    assert.equal((await waitForEvent(home, 'review-deferred', 2)).length, 2)
    assert.equal((await statusOf(host, live.id)).deferredCount, 1, 'a deferral reschedules one retry, never a growing set')
  })
})

for (const reason of ['disabled', 'no-index', 'embed-failed', 'shortlist-failed', 'empty-shortlist', 'judge-error', 'judge-timeout']) {
  test(`a degraded router (${reason}) defers the run and names the reason`, async () => {
    await withHome(async (home) => {
      const t = fakeHost({ suggestionService: { query: async () => ({ suggestions: [], rendered: '', degraded: true, reason, detail: `${reason} detail` }) } })
      t.start()
      const live = session(`session-degraded-${reason}`)
      t.sessions.set(live.id, live)
      t.fire(live, completedTurn)
      await flush()
      assert.equal(t.prompt(), undefined, 'a degraded run must send no review prompt')
      const deferred = (await waitForEvent(home, 'review-deferred'))[0]
      assert.ok(deferred, 'the deferral must be in the ledger')
      assert.equal(deferred.reason, reason, 'the ledger must name the degraded reason')
      assert.equal(deferred.detail, `${reason} detail`, 'the stage detail rides along')
      assert.equal((await statusOf(t, live.id)).deferredCount, 1, 'a degraded run schedules exactly one retry')
    })
  })
}

test('a manual review for the same session cancels the pending retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withHome(async () => {
    let calls = 0
    const host = fakeHost({ suggestionService: { query: async () => { calls++; return { suggestions: [], rendered: '', degraded: true, reason: 'judge-timeout' } } } })
    host.start()
    const live = session('session-cancel')
    host.sessions.set(live.id, live)
    host.fire(live, completedTurn)
    await flush()
    assert.equal((await statusOf(host, live.id)).deferredCount, 1)
    assert.equal(calls, 1)

    // A manual review is not an automatic trigger, so the pending retry does not
    // suppress it; it supersedes the retry instead of letting it double the work.
    const res = fakeRes()
    await host.routes[0].handler(postReviewNow(live.id), res)
    assert.equal(res.status, 202, 'the manual review must start')
    await flush()
    assert.equal(calls, 2, 'the manual review ran despite the pending retry')
    assert.equal((await statusOf(host, live.id)).deferredCount, 1, 'only one retry may be pending')

    t.mock.timers.tick(HOUR_MS)
    await flush()
    assert.equal(calls, 3, 'only the retry scheduled by the manual review may fire')
  })
})

test('an automatic trigger is suppressed while a retry is pending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withHome(async (home) => {
    let calls = 0
    const host = fakeHost({ suggestionService: { query: async () => { calls++; return { suggestions: [], rendered: '', degraded: true, reason: 'judge-timeout' } } } })
    host.start()
    const live = session('session-gated')
    host.sessions.set(live.id, live)
    host.fire(live, completedTurn)
    await flush()
    assert.equal(calls, 1)
    assert.equal((await statusOf(host, live.id)).deferredCount, 1)
    assert.equal((await ledger(home)).filter((e) => e.event === 'review-start').length, 1)

    // The restored window makes this turn meet the threshold, but the pending
    // retry already covers the session: no second router query, no second run.
    host.fire(live, completedTurn)
    await flush()
    assert.equal(calls, 1, 'an automatic trigger must not query while a retry is pending')
    assert.ok((await waitForEvent(home, 'review-trigger-suppressed'))[0], 'the suppression is recorded')
    const events = await ledger(home)
    assert.equal(events.filter((e) => e.event === 'review-start').length, 1, 'no second review may start')
  })
})

test('a completed turn recorded while the router query is pending survives the deferral', async () => {
  await withHome(async () => {
    let release
    const host = fakeHost({
      suggestionService: { query: () => new Promise((resolve) => { release = resolve }) },
      config: { turnInterval: 2, cooldownMinutes: 0, mode: 'log-only' },
    })
    host.start()
    const live = session('session-pending-turn')
    host.sessions.set(live.id, live)

    const res = fakeRes()
    await host.routes[0].handler(postReviewNow(live.id), res)
    assert.equal(res.status, 202, 'the manual review must start')
    assert.equal(typeof release, 'function', 'the router query must be pending')

    // A completed turn arrives while the query is still in flight. The deferral
    // restores the window by difference, so this turn is not overwritten.
    host.fire(live, completedTurn)
    release({ suggestions: [], rendered: '', degraded: true, reason: 'judge-timeout' })
    await flush()

    const status = await statusOf(host, live.id)
    assert.equal(status.current.turns, 1, 'the turn recorded during the pending query must survive the deferral')
    assert.equal(status.deferredCount, 1, 'the deferral still schedules its retry')
  })
})

test('a retry whose session is no longer live is dropped with its own ledger event', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withHome(async (home) => {
    let calls = 0
    const host = fakeHost({ suggestionService: { query: async () => { calls++; return { suggestions: [], rendered: '', degraded: true, reason: 'no-index' } } } })
    host.start()
    const live = session('session-gone')
    host.sessions.set(live.id, live)
    host.fire(live, completedTurn)
    await flush()
    const before = calls

    host.sessions.delete(live.id)
    t.mock.timers.tick(HOUR_MS)
    await flush()

    assert.equal(calls, before, 'a retry must not run a review for a session that is gone')
    const dropped = (await waitForEvent(home, 'review-retry-dropped'))[0]
    assert.ok(dropped, 'the dropped retry must leave its own ledger event')
    assert.equal(dropped.reason, 'session-gone')
    assert.equal(dropped.sessionId, live.id)
    assert.equal((await statusOf(host, live.id)).deferredCount, 0, 'the dropped retry is no longer pending')
  })
})

test('a pending retry is dropped on unload and never fires into a disposed context', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withHome(async () => {
    let calls = 0
    const host = fakeHost({ suggestionService: { query: async () => { calls++; return { suggestions: [], rendered: '', degraded: true, reason: 'embed-failed' } } } })
    host.start()
    const live = session('session-unload')
    host.sessions.set(live.id, live)
    host.fire(live, completedTurn)
    await flush()
    const before = calls

    for (const cleanup of host.cleanups) { try { cleanup() } catch {} }
    t.mock.timers.tick(HOUR_MS)
    await flush()
    assert.equal(calls, before, 'an unloaded plugin must never fire its retry')
  })
})

test('a router answer that arrives after unload is dropped: no deferral, no retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withHome(async (home) => {
    let release
    const host = fakeHost({ suggestionService: { query: () => new Promise((resolve) => { release = resolve }) } })
    host.start()
    const live = session('session-unload-pending')
    host.sessions.set(live.id, live)
    host.fire(live, completedTurn)
    assert.ok(await waitFor(() => typeof release === 'function'), 'the router query must be in flight before unload')

    // Unload while the query is still pending. Cleanup can clear the retry map and
    // abort the controller, but it cannot cancel a promise it does not own.
    for (const cleanup of host.cleanups) { try { cleanup() } catch {} }
    release({ suggestions: [], rendered: '', degraded: true, reason: 'judge-timeout', detail: 'late answer' })
    await flush(40)

    const events = await ledger(home)
    assert.ok(!events.some((e) => e.event === 'review-deferred'), 'a late answer must not record a deferral')
    assert.ok(!events.some((e) => e.event === 'review-retry-scheduled'), 'a late answer must not schedule a retry')
    assert.equal((await statusOf(host, live.id)).deferredCount, 0, 'no retry may be pending after unload')
  })
})

test('a suggestion query that throws is treated as degradation, not as a clean run', async () => {
  await withHome(async (home) => {
    const t = fakeHost({ suggestionService: { query: async () => { throw new Error('socket closed') } } })
    t.start()
    const live = session('session-throw')
    t.sessions.set(live.id, live)
    t.fire(live, completedTurn)
    await flush()
    assert.equal(t.prompt(), undefined, 'a throwing service must not produce a review prompt')
    const deferred = (await waitForEvent(home, 'review-deferred'))[0]
    assert.ok(deferred, 'a thrown query still defers the run')
    assert.match(deferred.detail, /socket closed/, 'the failure is recorded')
  })
})

test('a router result that is an array defers instead of running a healthy empty review', async () => {
  await withHome(async (home) => {
    const t = fakeHost({ suggestionService: { query: async () => [] } })
    t.start()
    const live = session('session-malformed-array')
    t.sessions.set(live.id, live)
    t.fire(live, completedTurn)
    await flush()
    assert.equal(t.prompt(), undefined, 'a malformed result must not send a review prompt')
    assert.equal(t.created.length, 0, 'a malformed result must not create the review agent')
    const deferred = await deferralFor(home, live.id)
    assert.equal(deferred.length, 1, 'exactly one deferral must be recorded')
    assert.equal(deferred[0].reason, 'query-failed', 'the deferral must name the contract failure')
  })
})

test('every router result outside the published contract defers as query-failed', async () => {
  await withHome(async (home) => {
    const shapes = [
      ['missing degraded', { suggestions: [], rendered: '' }],
      ['non-array suggestions', { suggestions: 'none', rendered: '', degraded: false }],
      ['non-string rendered', { suggestions: [], rendered: 42, degraded: false }],
    ]
    for (const [label, answer] of shapes) {
      const t = fakeHost({ suggestionService: { query: async () => answer } })
      t.start()
      const live = session(`session-malformed-${label.replace(/\W+/g, '-')}`)
      t.sessions.set(live.id, live)
      t.fire(live, completedTurn)
      await flush()
      assert.equal(t.prompt(), undefined, `${label}: no review prompt may be sent`)
      const deferred = await deferralFor(home, live.id)
      assert.equal(deferred.length, 1, `${label}: exactly one deferral must be recorded`)
      assert.equal(deferred[0].reason, 'query-failed', `${label}: the deferral must name the contract failure`)
    }
  })
})
