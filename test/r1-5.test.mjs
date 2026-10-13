// R1-5 red test (verifier, scratch copy only).
// A write-time fault in the middle of a reference-file set. Required behaviour:
// applyConclusion resolves with a 'rejected' result, and no file from the
// conclusion stays on disk. Current code: the error escapes as a throw and the
// earlier files stay.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, readdir, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { createRequire } from 'node:module'

process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'r1-5-home-'))

const require = createRequire(import.meta.url)
const plugin = require('../src/index.js')
const { applyConclusion, sha256, buildSkillMd } = plugin.__internals

// The module writes through this same object (fsP = require('node:fs/promises')),
// so replacing rename on it is how a test injects a write-time fault.
const fsp = require('node:fs/promises')

const SKILL_MD = buildSkillMd('topic', 'Use when working on topic tasks.', '# topic\nSee references/setup.md.\n')
const PATCH_BODY = '# topic\nSee references/setup.md, references/a-new.md and references/b-new.md.\n'
// R1-5b body: names only files[] entries, so the F3 pointer rule does not refuse the
// conclusion before the SKILL.md rename, which is the step under test.
const PATCH_BODY_B = '# topic\nSee references/setup.md and references/a-new.md.\n'

async function seed() {
  const globalDir = await mkdtemp(join(tmpdir(), 'r1-5-global-'))
  const skillDir = join(globalDir, 'topic')
  await mkdir(join(skillDir, 'references'), { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), SKILL_MD)
  await writeFile(join(skillDir, 'references', 'setup.md'), 'v1\n')
  return { globalDir, skillDir }
}

function patch(files, body = PATCH_BODY) {
  return { action: 'patch', skill: 'topic', body, rationale: 'r1-5 probe', baseHash: sha256(SKILL_MD), files }
}

// Runs fn with fsP.rename wrapped. hook(target) runs before each real rename.
async function withRenameHook(hook, fn) {
  const real = fsp.rename
  fsp.rename = async (from, to) => {
    await hook(String(to))
    return real(from, to)
  }
  try { return await fn() } finally { fsp.rename = real }
}

async function outcomeOf(conclusion, globalDir) {
  try { return { value: await applyConclusion(conclusion, { globalDir }) } } catch (e) { return { thrown: e } }
}

async function exists(p) { try { await lstat(p); return true } catch { return false } }
async function tempNames(dir) { try { return (await readdir(dir)).filter((n) => n.endsWith('.tmp')) } catch { return [] } }

// Scenario A: two new reference files. The second file's rename fails with a real
// EISDIR, induced by making its target path a directory after planning and before
// the rename. The first file has already been written by then.
test('R1-5a: a failed second write rejects the set and leaves no file from it', async () => {
  const { globalDir, skillDir } = await seed()
  const out = await withRenameHook(
    async (to) => { if (basename(to) === 'b-new.md') await fsp.mkdir(to) },
    () => outcomeOf(patch([
      { path: 'references/a-new.md', content: 'A\n' },
      { path: 'references/b-new.md', content: 'B\n' },
    ]), globalDir),
  )
  assert.equal(out.thrown, undefined, `applyConclusion threw instead of returning a result: ${out.thrown && out.thrown.message}`)
  assert.equal(out.value.result, 'rejected')
  assert.equal(await exists(join(skillDir, 'references', 'a-new.md')), false, 'a-new.md from the rejected set is still on disk')
  assert.equal(await readFile(join(skillDir, 'references', 'setup.md'), 'utf8'), 'v1\n')
  assert.equal(await readFile(join(skillDir, 'SKILL.md'), 'utf8'), SKILL_MD)
  assert.deepEqual(await tempNames(join(skillDir, 'references')), [], 'temp file left in references/')
  assert.deepEqual(await tempNames(skillDir), [], 'temp file left in the skill directory')
})

// Scenario B: a new file, then an existing file overwritten (v1 to v2), then the
// SKILL.md rename fails with ENOSPC (injected error, no disk effect). Both the new
// file and the overwrite must be undone.
test('R1-5b: a failed SKILL.md write rolls back the references already written', async () => {
  const { globalDir, skillDir } = await seed()
  const out = await withRenameHook(
    async (to) => {
      if (basename(to) === 'SKILL.md') throw Object.assign(new Error('ENOSPC: injected rename failure for SKILL.md'), { code: 'ENOSPC' })
    },
    () => outcomeOf(patch([
      { path: 'references/a-new.md', content: 'A\n' },
      { path: 'references/setup.md', content: 'v2\n', baseHash: sha256('v1\n') },
    ], PATCH_BODY_B), globalDir),
  )
  assert.equal(out.thrown, undefined, `applyConclusion threw instead of returning a result: ${out.thrown && out.thrown.message}`)
  assert.equal(out.value.result, 'rejected')
  assert.equal(await exists(join(skillDir, 'references', 'a-new.md')), false, 'a-new.md from the rejected set is still on disk')
  assert.equal(await readFile(join(skillDir, 'references', 'setup.md'), 'utf8'), 'v1\n', 'setup.md was overwritten and not restored')
  assert.equal(await readFile(join(skillDir, 'SKILL.md'), 'utf8'), SKILL_MD)
  assert.deepEqual(await tempNames(join(skillDir, 'references')), [], 'temp file left in references/')
  assert.deepEqual(await tempNames(skillDir), [], 'temp file left in the skill directory')
})
