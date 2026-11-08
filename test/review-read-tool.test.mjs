/**
 * d3ek: the review agent's one tool, a skill-file read that returns the exact
 * file text and the SHA-256 of that text.
 *
 * Two layers are exercised. The tool contract (hash value, path refusal, size
 * refusal, count cap) runs the shipped builder directly. Registration and the
 * patch round trip drive the shipped review runner through a fake host whose
 * tool registry models the documented layering: `restrict` filters only what a
 * scope INHERITS, and a scoped `register` stays visible (dsh-tools registry
 * `view()`), which is why an empty allow-list plus one scoped registration
 * leaves the review agent with exactly one tool.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const plugin = createRequire(import.meta.url)('../src/index.js')
const { __internals: I } = plugin

const TOOL = 'read_skill_file'
const completedTurn = { type: 'turn/end', data: { reason: { kind: 'completed' } } }

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'hermes-read-tool-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    // The tracer writes the ledger fire-and-forget, so a removal can race an
    // append that recreates the directory; retry ENOTEMPTY like the router tests.
    for (let attempt = 0; ; attempt++) {
      try { await rm(home, { recursive: true, force: true }); break } catch (e) {
        if (e.code !== 'ENOTEMPTY' || attempt >= 4) throw e
        await flush(2)
      }
    }
  }
}

async function writeSkill(home, name, body) {
  const dir = join(home, 'skills', name)
  await mkdir(dir, { recursive: true })
  const text = `---\nname: ${JSON.stringify(name)}\ndescription: "${name} description"\n---\n\n${body}\n`
  await writeFile(join(dir, 'SKILL.md'), text)
  return { dir, file: join(dir, 'SKILL.md'), text }
}

/** Let every already-resolved promise and the fire-and-forget ledger write run. */
async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve))
}

/**
 * Wait for a predicate with a wall-clock budget. The review run does real file
 * IO, so a fixed number of microtask turns can expire on a loaded machine while
 * the run is still healthy; the budget is what makes the wait deterministic.
 */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return true
}

/**
 * A fake host with a registry-shaped `tools` service. `schemas()` is the set the
 * review agent's model is offered: its own registrations, because a restriction
 * only filters the inherited layers.
 */
function fakeHost({ suggestions = [], respond, mode = 'log-only' } = {}) {
  const handlers = []
  const infos = []
  const warns = []
  const sessions = new Map()
  const prompts = []
  const created = []
  const events = []
  let inSetup = false
  // The inherited layer: every scope starts with these tools. `restrict` filters
  // only this layer, and the scope's own registrations are added after the
  // filter (dsh-tools registry `view()`), so a scope with `allow: []` and one
  // registration sees exactly that registration, while a sibling scope that
  // never restricted still sees the inherited tool.
  const inherited = new Map([
    ['inherited_tool', { name: 'inherited_tool', description: 'a tool every normal agent inherits', parameters: { type: 'object', properties: {} } }],
  ])
  const registered = []
  const registrations = []
  const restrictions = []
  const visibleInherited = () => {
    const names = new Set(inherited.keys())
    for (const filter of restrictions) {
      if (filter === undefined || filter === null) continue
      for (const name of [...names]) {
        const allowed = filter.allow === undefined
          || (Array.isArray(filter.allow) && filter.allow.includes(name))
        const denied = Array.isArray(filter.deny) && filter.deny.includes(name)
        if (!allowed || denied) names.delete(name)
      }
    }
    return [...names].map((name) => inherited.get(name))
  }
  const tools = {
    inherited,
    registered,
    registrations,
    restrictions,
    register(definition) {
      registered.push(definition)
      registrations.push({ name: definition.name, duringSetup: inSetup })
      return () => {}
    },
    restrict(filter) {
      restrictions.push(filter)
      return () => {}
    },
    schemas() {
      const visible = new Map(visibleInherited().map((definition) => [definition.name, definition]))
      for (const definition of registered) visible.set(definition.name, definition)
      return [...visible.values()].map(({ name, description, parameters }) => ({ name, description, parameters }))
    },
    siblingSchemas() {
      // A normal agent's scope: the same inherited layer, no restriction of its
      // own, no review registration.
      return [...inherited.values()].map(({ name, description, parameters }) => ({ name, description, parameters }))
    },
  }
  const agentCtx = { get: () => undefined, tools }
  const agent = {
    session: { seq: 0, snapshotEvents: () => events },
    followup(message) { prompts.push(message) },
    async whenIdle() { if (respond) await respond({ tools, prompts, events }) },
    cancel() {},
  }
  const rendered = suggestions
    .map((s) => `- ${s.name}: ${s.description}` + (s.path ? ` [read: ${s.path}]` : ''))
    .join('\n')
  const ctx = {
    logger: { info: (m) => infos.push(String(m)), warn: (m) => warns.push(String(m)) },
    connection: { requestRejection: () => undefined },
    on: (name, fn) => { handlers.push(fn); return () => {} },
    effect: (fn) => { fn() },
    skills: { snapshot: async () => ({ skills: [], complete: true }) },
    settings: undefined,
    sessions: { get: (id) => sessions.get(id) },
    get: (name) => (name === 'skillRouterSuggestions'
      ? { query: async () => ({ suggestions, rendered, degraded: false }) }
      : undefined),
    agents: {
      create: async (opts) => {
        created.push(opts)
        if (typeof opts.setup === 'function') {
          inSetup = true
          try { await opts.setup(agentCtx, agent) } finally { inSetup = false }
        }
        return { agent, dispose: async () => {} }
      },
      get: () => undefined,
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'prov', model: 'mdl' }) },
    inject: () => {},
  }
  plugin.apply(ctx, { turnInterval: 1, cooldownMinutes: 0, mode })
  return {
    tools,
    created,
    prompts,
    infos,
    warns,
    fire: (session, event) => { for (const h of handlers) h(session, event) },
    sessions,
    start(session) {
      sessions.set(session.id, session)
      for (const h of handlers) h(session, completedTurn)
    },
  }
}

function liveSession(id, messages = [{ role: 'user', content: 'we fixed the review read budget' }]) {
  return { id, header: {}, deriveMessages: () => messages, append: () => {} }
}

/**
 * The read route of the review prompt's suggestion block. The block is the last
 * section the runner appends, and the router renders each route as
 * `[read: <absolute path>]` on the skill's own line, so the last marker is the
 * one the reviewer is meant to open.
 */
function suggestedReadPath(prompt) {
  const matches = [...prompt.matchAll(/\[read: ([^\]]+)\]/g)]
  assert.ok(matches.length > 0, 'the suggestion block must carry a read route')
  return matches.at(-1)[1]
}

// ── the tool contract ────────────────────────────────────────────────────

test('a read returns the file text and the SHA-256 of that exact text', async () => {
  await withHome(async (home) => {
    const skill = await writeSkill(home, 'alpha-skill', 'body v1')
    const tool = I.buildReviewSkillReadTool()
    const value = await tool.execute({ path: skill.file }, {})

    assert.equal(value.text, skill.text, 'the whole file text must come back unchanged')
    assert.equal(value.sha256, sha256(skill.text), 'the hash must be of the exact returned text')
    assert.equal(value.path, skill.file)
    // The rendered content is what the model reads: both the hash and the text.
    const blocks = tool.output.render({ path: skill.file }, value)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].type, 'text')
    assert.ok(blocks[0].text.includes(value.sha256), 'the rendered read must carry the hash')
    assert.ok(blocks[0].text.includes(skill.text), 'the rendered read must carry the exact text')
    // The model-facing schema names only the one argument it takes.
    assert.deepEqual(tool.parameters.required, ['path'])
    assert.deepEqual(Object.keys(tool.parameters.properties), ['path'])
  })
})

test('a path outside the global skill library is refused, naming the restriction', async () => {
  await withHome(async (home) => {
    const skill = await writeSkill(home, 'alpha-skill', 'body v1')
    const tool = I.buildReviewSkillReadTool()
    const outside = [
      '/etc/passwd',
      join(home, 'skills-extra', 'evil', 'SKILL.md'), // sibling of the library, not inside it
      join(home, 'skills', '..', 'notes', 'SKILL.md'), // traversal out of the library
      join(home, 'skills', 'alpha-skill', 'references', 'notes.md'), // inside, but not a SKILL.md
    ]
    for (const path of outside) {
      await assert.rejects(
        () => tool.execute({ path }, {}),
        (error) => {
          assert.match(error.message, /global skill library/, `the refusal must name the restriction: ${path}`)
          return true
        },
      )
    }
    // The refused reads consumed nothing: the library skill still reads.
    const value = await tool.execute({ path: skill.file }, {})
    assert.equal(value.sha256, sha256(skill.text))
  })
})

test('a file over the patchable ceiling is refused at read time and cannot be patched this run', async () => {
  await withHome(async (home) => {
    const ceiling = I.PATCHABLE_BODY_MAX_CHARS
    assert.equal(ceiling, 8 * 1024, 'the read ceiling is the writer patchable ceiling')
    // The oversized fixture is ~8 KiB: far below BODY_MAX_CHARS (128 KiB), so a
    // read that used the create ceiling would return it instead of refusing.
    const fileAtCeiling = join(home, 'skills', 'at-ceiling', 'SKILL.md')
    const fileOverCeiling = join(home, 'skills', 'too-big', 'SKILL.md')
    await mkdir(join(home, 'skills', 'at-ceiling'), { recursive: true })
    await mkdir(join(home, 'skills', 'too-big'), { recursive: true })
    // A real SKILL.md shape at an exact total length, so the fixture is a file
    // the writer could meet, not a bare run of padding.
    const skillOfLength = (length, pad) => {
      const head = `---\nname: "big"\ndescription: "d"\n---\n\n`
      return head + pad.repeat(Math.max(0, length - head.length))
    }
    const atCeilingText = skillOfLength(ceiling, 'x')
    await writeFile(fileAtCeiling, atCeilingText)
    await writeFile(fileOverCeiling, skillOfLength(ceiling + 1, 'y'))
    const tool = I.buildReviewSkillReadTool()

    // Exactly at the ceiling is patchable: the writer refuses only `> ceiling`.
    const ok = await tool.execute({ path: fileAtCeiling }, {})
    assert.equal(ok.text.length, ceiling)
    assert.equal(ok.sha256, sha256(atCeilingText))

    await assert.rejects(
      () => tool.execute({ path: fileOverCeiling }, {}),
      (error) => {
        assert.match(error.message, /cannot be patched this run/, 'the refusal must say the file cannot be patched this run')
        assert.match(error.message, new RegExp(String(ceiling)), 'the refusal must name the ceiling it crossed')
        return true
      },
    )
    // The oversized refusal did not spend a read.
    const again = await tool.execute({ path: fileAtCeiling }, {})
    assert.equal(again.sha256, sha256(atCeilingText))
  })
})

test('the fourth successful read is refused as budget spent, and a new review gets a fresh budget', async () => {
  await withHome(async (home) => {
    assert.equal(I.REVIEW_SKILL_READ_MAX, 3, 'the ticket caps one review at three successful reads')
    const skill = await writeSkill(home, 'alpha-skill', 'body v1')
    const tool = I.buildReviewSkillReadTool()

    for (let read = 1; read <= 3; read++) {
      const value = await tool.execute({ path: skill.file }, {})
      assert.equal(value.sha256, sha256(skill.text), `read ${read} succeeds`)
    }
    await assert.rejects(
      () => tool.execute({ path: skill.file }, {}),
      (error) => {
        assert.match(error.message, /budget is spent/i, 'the fourth read must say the budget is spent')
        assert.match(error.message, /3/, 'the refusal must name the cap')
        return true
      },
    )

    // The counter is the review run's closure, not module state: a second review
    // starts with a full budget of its own.
    const second = I.buildReviewSkillReadTool()
    const value = await second.execute({ path: skill.file }, {})
    assert.equal(value.sha256, sha256(skill.text))
  })
})

test('a symlinked global skill is readable through its catalog realpath and patches with that hash', async () => {
  await withHome(async (home) => {
    // The live shape: 87 of this machine's 90 global skills are symlinks into
    // dotfiles, and the skill catalog reports each entry's realpath, so the
    // suggestion block names the target file, not the library entry path.
    const targetDir = join(home, 'dotfiles-skills', 'linked-skill')
    await mkdir(targetDir, { recursive: true })
    const text = `---\nname: "linked-skill"\ndescription: "linked description"\n---\n\nlinked body line\n`
    await writeFile(join(targetDir, 'SKILL.md'), text)
    await mkdir(join(home, 'skills'), { recursive: true })
    await symlink(targetDir, join(home, 'skills', 'linked-skill'), 'dir')

    const catalogPath = await realpath(join(home, 'skills', 'linked-skill', 'SKILL.md'))
    assert.equal(catalogPath, await realpath(join(targetDir, 'SKILL.md')), 'the catalog path is the entry target')

    const tool = I.buildReviewSkillReadTool()
    const value = await tool.execute({ path: catalogPath }, {})
    assert.equal(value.text, text)
    assert.equal(value.sha256, sha256(text))

    // The writer patches by entry name, through the same symlink, and the hash
    // the read returned is the one its CAS accepts.
    const body = value.text.split('---\n\n')[1].trimEnd() + '\n\n- patched through the link\n'
    const out = await I.applyConclusion(
      { action: 'patch', skill: 'linked-skill', body, baseHash: value.sha256 },
      { globalDir: join(home, 'skills') },
    )
    assert.equal(out.result, 'patched', JSON.stringify(out))
    assert.match(await readFile(join(targetDir, 'SKILL.md'), 'utf8'), /patched through the link/)

    // A file no library entry points at is still refused.
    const orphanDir = join(home, 'dotfiles-skills', 'orphan')
    await mkdir(orphanDir, { recursive: true })
    await writeFile(join(orphanDir, 'SKILL.md'), 'orphan\n')
    await assert.rejects(
      () => tool.execute({ path: join(orphanDir, 'SKILL.md') }, {}),
      /global skill library/,
    )
  })
})

test('a SKILL.md that is itself a symlink is refused and the link and target are left alone', async () => {
  await withHome(async (home) => {
    // A directory-shaped entry whose SKILL.md is a file-level link. The catalog
    // reports the link target, so this path can reach the tool even though the
    // writer patches by entry name and renames over the entry path: the rename
    // would replace the link with a regular file and leave the target stale.
    const externalDir = join(home, 'dotfiles-skills', 'file-linked')
    await mkdir(externalDir, { recursive: true })
    const externalFile = join(externalDir, 'SKILL.md')
    const text = `---\nname: "file-linked"\ndescription: "linked description"\n---\n\nlinked body line\n`
    await writeFile(externalFile, text)
    const entryDir = join(home, 'skills', 'file-linked')
    await mkdir(entryDir, { recursive: true })
    const link = join(entryDir, 'SKILL.md')
    await symlink(externalFile, link, 'file')
    const catalogPath = await realpath(link)

    const tool = I.buildReviewSkillReadTool()
    // Both routes name the same library skill, so both must refuse before a
    // read: the entry path and the realpath the catalog reports.
    for (const path of [link, catalogPath]) {
      await assert.rejects(
        () => tool.execute({ path }, {}),
        (error) => {
          assert.match(error.message, /symlink/, `the refusal must say the file is a link: ${path}`)
          assert.match(error.message, /cannot be patched safely this run/, `the refusal must say why: ${path}`)
          return true
        },
      )
    }
    // A refused read writes nothing: the link survives and the target is unchanged.
    assert.equal((await lstat(link)).isSymbolicLink(), true, 'the refused read must not sever the link')
    assert.equal(await readFile(externalFile, 'utf8'), text, 'the external target must be untouched')
    // The two refusals spent no budget: a regular library skill still reads.
    const normal = await writeSkill(home, 'normal-skill', 'body v1')
    const value = await tool.execute({ path: normal.file }, {})
    assert.equal(value.sha256, sha256(normal.text), 'a refused linked read must not spend a read')
  })
})

// ── registration and the round trip through the review runner ────────────

test('the review agent sees exactly one tool, registered through its own setup scope', async () => {
  await withHome(async () => {
    const host = fakeHost({ suggestions: [] })
    assert.equal(host.tools.registered.length, 0, 'applying the plugin must register no global tool; a normal agent is unchanged')
    // The fake's inherited layer is what a normal scope starts with. With no
    // restriction yet, that is all this scope sees.
    assert.deepEqual(
      host.tools.schemas().map((schema) => schema.name),
      ['inherited_tool'],
      'the inherited sentinel is visible before the review scope restricts it',
    )

    host.start(liveSession('session-visible'))
    assert.ok(await waitFor(() => host.created.length === 1), 'the review agent must be created')
    assert.ok(await waitFor(() => host.tools.registered.length === 1), 'the tool must be registered during setup')

    assert.equal(host.created[0].meta.origin, 'subagent')
    assert.deepEqual(
      host.tools.registrations,
      [{ name: TOOL, duringSetup: true }],
      'the only registration happens in the review agent setup',
    )
    assert.deepEqual(host.tools.restrictions, [{ allow: [] }], 'the inherited allow-list stays empty')
    assert.deepEqual(
      host.tools.schemas().map((schema) => schema.name),
      [TOOL],
      'the empty allow-list masks the inherited tool; the scoped registration is the only visible tool',
    )
    assert.deepEqual(
      host.tools.siblingSchemas().map((schema) => schema.name),
      ['inherited_tool'],
      'a normal agent scope still sees the inherited tool and never the review registration',
    )
    // The schema the model receives carries all three definition fields.
    const [visible] = host.tools.schemas()
    assert.equal(typeof visible.description, 'string')
    assert.equal(visible.parameters.type, 'object')
  })
})

test('a patch round trip: the reviewer reads a global skill and patches it with the returned hash', async () => {
  await withHome(async (home) => {
    const skill = await writeSkill(home, 'alpha-skill', 'original body line')
    let read
    const host = fakeHost({
      mode: 'auto',
      suggestions: [{ name: 'alpha-skill', description: 'the skill under review', path: skill.file }],
      respond: async ({ tools, prompts, events }) => {
        const prompt = prompts[0].content[0].text
        const tool = tools.registered.find((definition) => definition.name === TOOL)
        assert.ok(tool, 'the review agent must have the read tool')
        read = await tool.execute({ path: suggestedReadPath(prompt) }, {})
        // The patch is built from the text the read returned, and its baseHash is
        // the hash the same read returned.
        const body = read.text.split('---\n\n')[1].trimEnd() + '\n\n## Verification\n\n- patch round trip\n'
        const conclusion = JSON.stringify({
          action: 'patch', skill: 'alpha-skill', body, baseHash: read.sha256, rationale: 'round trip',
        })
        events.push({
          seq: 1,
          type: 'assistant/message',
          data: { message: { role: 'assistant', content: [{ type: 'text', text: '```json\n' + conclusion + '\n```' }] } },
        })
      },
    })

    host.start(liveSession('session-round-trip'))
    assert.ok(
      await waitFor(() => host.infos.some((m) => m.includes('patched'))),
      `infos: ${host.infos.join('|')} warns: ${host.warns.join('|')} created: ${host.created.length} prompts: ${host.prompts.length}`,
    )

    assert.equal(read.sha256, sha256(skill.text), 'the hash came from the exact file text')
    const written = await readFile(skill.file, 'utf8')
    assert.ok(written.includes('original body line'), 'the original body survives the patch')
    assert.ok(written.includes('- patch round trip'), 'the patched body landed')
    assert.match(written, /^---\nname: "alpha-skill"\ndescription: "alpha-skill description"\n---\n/, 'the frontmatter survives')
    assert.ok(written.length <= I.PATCHABLE_BODY_MAX_CHARS + 200, 'the patched file stays small')
  })
})

test('a patch whose base hash is not the read hash still fails the writer conflict check', async () => {
  await withHome(async (home) => {
    const skill = await writeSkill(home, 'alpha-skill', 'original body line')
    const host = fakeHost({
      mode: 'auto',
      suggestions: [{ name: 'alpha-skill', description: 'the skill under review', path: skill.file }],
      respond: async ({ tools, prompts, events }) => {
        const prompt = prompts[0].content[0].text
        const tool = tools.registered.find((definition) => definition.name === TOOL)
        const read = await tool.execute({ path: suggestedReadPath(prompt) }, {})
        assert.equal(read.sha256, sha256(skill.text))
        const conclusion = JSON.stringify({
          action: 'patch',
          skill: 'alpha-skill',
          body: 'rewritten body',
          baseHash: 'a'.repeat(64), // not the hash the read returned
          rationale: 'round trip',
        })
        events.push({
          seq: 1,
          type: 'assistant/message',
          data: { message: { role: 'assistant', content: [{ type: 'text', text: '```json\n' + conclusion + '\n```' }] } },
        })
      },
    })

    host.start(liveSession('session-cas'))
    assert.ok(await waitFor(() => host.warns.some((m) => m.includes('cas-conflict'))), host.warns.join('|'))
    assert.equal(await readFile(skill.file, 'utf8'), skill.text, 'a mismatched hash must write nothing')
  })
})
