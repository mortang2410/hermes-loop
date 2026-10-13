import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, readdir, lstat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// R1-2 (verifier red test). A SKILL.md body that names references/<x>.md must not
// land unless that file is in this conclusion's files[] or is already a regular
// file on disk. The writer currently checks the body for non-empty text only
// (src/index.js:440 at parse, 741-744 and 767-770 at write).

process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'r1-2-home-'))

const require = createRequire(import.meta.url)
const plugin = require('../src/index.js')
const { applyConclusion, sha256 } = plugin.__internals

const TOPIC_SKILL_MD = '---\nname: "topic-skill"\ndescription: "orig"\n---\n\nbody v1\n'

async function tempGlobalDir() {
  return mkdtemp(join(tmpdir(), 'r1-2-'))
}

async function topicSkillDir(globalDir) {
  await mkdir(join(globalDir, 'topic-skill', 'references'), { recursive: true })
  await writeFile(join(globalDir, 'topic-skill', 'SKILL.md'), TOPIC_SKILL_MD)
  await writeFile(join(globalDir, 'topic-skill', 'references', 'setup.md'), 'setup v1\n')
}

async function exists(path) {
  try { await lstat(path); return true } catch { return false }
}

// ── DEFECT: a body pointer to an absent reference file lands ───────────────

test('R1-2 create: body names references/missing.md, files absent -> refused, nothing written', async () => {
  const dir = await tempGlobalDir()
  const out = await applyConclusion({
    action: 'create', skill: 'ptr-skill', description: 'Use when pointing.',
    body: '# p\nSee references/missing.md for steps.\n',
  }, { globalDir: dir })
  assert.notEqual(out.result, 'created', 'a body naming an absent reference file must be refused')
  assert.equal(await exists(join(dir, 'ptr-skill')), false, 'no skill directory may be written')
})

test('R1-2 patch: body names references/missing.md, files absent -> refused, SKILL.md unchanged', async () => {
  const dir = await tempGlobalDir()
  await topicSkillDir(dir)
  const out = await applyConclusion({
    action: 'patch', skill: 'topic-skill', body: 'body v2\nSee references/missing.md.\n',
    baseHash: sha256(TOPIC_SKILL_MD), baseDescription: 'orig', rationale: 'r',
  }, { globalDir: dir })
  assert.notEqual(out.result, 'patched', 'a body naming an absent reference file must be refused')
  assert.equal(await readFile(join(dir, 'topic-skill', 'SKILL.md'), 'utf8'), TOPIC_SKILL_MD, 'SKILL.md must not change')
  assert.deepEqual(await readdir(join(dir, 'topic-skill', 'references')), ['setup.md'], 'no reference file may be written')
})

test('R1-2 create: body names references/missing.md while files carries a different file -> refused, nothing written', async () => {
  const dir = await tempGlobalDir()
  const out = await applyConclusion({
    action: 'create', skill: 'mix-skill', description: 'Use when mixing.',
    body: 'See references/missing.md.',
    files: [{ path: 'references/present.md', content: 'p\n' }],
  }, { globalDir: dir })
  assert.notEqual(out.result, 'created', 'a body naming a file outside files[] and off disk must be refused')
  assert.equal(await exists(join(dir, 'mix-skill')), false, 'no skill directory may be written')
})

// ── CONTROLS: must pass on the current code and after any fix ──────────────

test('R1-2 control: body names references/present.md and files carries it -> lands', async () => {
  const dir = await tempGlobalDir()
  const out = await applyConclusion({
    action: 'create', skill: 'ok-skill', description: 'Use when ok.',
    body: 'See references/present.md.',
    files: [{ path: 'references/present.md', content: 'p\n' }],
  }, { globalDir: dir })
  assert.equal(out.result, 'created')
  assert.equal(await readFile(join(dir, 'ok-skill', 'references', 'present.md'), 'utf8'), 'p\n')
})

test('R1-2 control: body names references/setup.md, a regular file on disk not in files -> lands', async () => {
  const dir = await tempGlobalDir()
  await topicSkillDir(dir)
  const out = await applyConclusion({
    action: 'patch', skill: 'topic-skill', body: 'body v2\nSee references/setup.md.\n',
    baseHash: sha256(TOPIC_SKILL_MD), baseDescription: 'orig', rationale: 'r',
  }, { globalDir: dir })
  assert.equal(out.result, 'patched')
  assert.equal(await readFile(join(dir, 'topic-skill', 'references', 'setup.md'), 'utf8'), 'setup v1\n', 'the untouched file keeps its content')
})

// ── JUDGEMENT (not the reviewer's claim): a pointer to a symlink ───────────
// The writer refuses to write through a symlink (src/index.js:800-801) and the
// lister skips symlinks (src/index.js:861). This test asks that a body pointer
// to a symlinked reference file is refused too. Labelled as the verifier's rule,
// see verify/R1-2.md.

test('R1-2 judgement: body names references/link.md, a symlink to a file outside the skill -> refused', async () => {
  const dir = await tempGlobalDir()
  const outside = await tempGlobalDir()
  await writeFile(join(outside, 'target.md'), 'outside\n')
  await topicSkillDir(dir)
  await symlink(join(outside, 'target.md'), join(dir, 'topic-skill', 'references', 'link.md'))
  const out = await applyConclusion({
    action: 'patch', skill: 'topic-skill', body: 'body v2\nSee references/link.md.\n',
    baseHash: sha256(TOPIC_SKILL_MD), baseDescription: 'orig', rationale: 'r',
  }, { globalDir: dir })
  assert.notEqual(out.result, 'patched', 'a body pointer must resolve to a regular file, not a symlink')
})
