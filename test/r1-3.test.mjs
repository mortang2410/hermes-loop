import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// R1-3 red tests. Root reads any file, so the unreadable-file cases are skipped
// under root; run them as a normal user.
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'r1-3-dsh-home-'))

const require = createRequire(import.meta.url)
const plugin = require('../src/index.js')
const { applyConclusion, sha256, buildSkillMd } = plugin.__internals

const ORIGINAL = 'ORIGINAL SETUP\n'
const NEW = 'OVERWRITTEN\n'
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0
const SKIP_UNREADABLE = asRoot ? 'root reads every file, so no file here is unreadable' : false

// A skill with references/setup.md holding ORIGINAL. refsMode and fileMode set
// what the writer can read; restore() puts the modes back so the test can read.
async function fixture({ refsMode, fileMode, withSkillMd = true }) {
  const globalDir = await mkdtemp(join(tmpdir(), 'r1-3-'))
  const skill = join(globalDir, 'topic')
  await mkdir(join(skill, 'references'), { recursive: true })
  const skillMd = buildSkillMd('topic', 'Use when working on topic tasks.', '# topic\nSee references/setup.md.')
  if (withSkillMd) await writeFile(join(skill, 'SKILL.md'), skillMd)
  const file = join(skill, 'references', 'setup.md')
  await writeFile(file, ORIGINAL)
  await chmod(file, fileMode)
  await chmod(join(skill, 'references'), refsMode)
  const restore = async () => {
    await chmod(join(skill, 'references'), 0o755).catch(() => {})
    await chmod(file, 0o644).catch(() => {})
  }
  return { globalDir, skill, skillMd, file, restore }
}

function patchNoHash(fx) {
  return {
    action: 'patch', skill: 'topic', body: '# topic\nSee references/setup.md.\n',
    baseHash: sha256(fx.skillMd), files: [{ path: 'references/setup.md', content: NEW }],
  }
}

// RED: the file exists, cannot be read, and was never shown to the reviewer.
// A write with no baseHash must be refused, and the file must keep ORIGINAL.
test('R1-3 red: no-baseHash patch over an existing unreadable reference file is refused', { skip: SKIP_UNREADABLE }, async () => {
  const fx = await fixture({ refsMode: 0o755, fileMode: 0o000 })
  let res
  try {
    res = await applyConclusion(patchNoHash(fx), { globalDir: fx.globalDir })
  } finally { await fx.restore() }
  // The result is pinned, not only the bytes: with the guard off, a later read
  // refuses as 'rejected' and the bytes still match, so bytes alone do not bite.
  assert.equal(res.result, 'create-conflict', `refused as '${res.result}', not by the unreadable-file guard`)
  assert.equal(await readFile(fx.file, 'utf8'), ORIGINAL, `writer returned '${res.result}' and overwrote an unseen file`)
})

// RED: the reviewer's combined case (references/ unreadable too, so the listing is empty).
test('R1-3 red: same, with references/ also unreadable (reviewer FO1 case)', { skip: SKIP_UNREADABLE }, async () => {
  const fx = await fixture({ refsMode: 0o300, fileMode: 0o000 })
  let res
  try {
    res = await applyConclusion(patchNoHash(fx), { globalDir: fx.globalDir })
  } finally { await fx.restore() }
  assert.equal(res.result, 'create-conflict', `refused as '${res.result}', not by the unreadable-file guard`)
  assert.equal(await readFile(fx.file, 'utf8'), ORIGINAL, `writer returned '${res.result}' and overwrote an unseen file`)
})

// RED: create path. The skill dir has no SKILL.md (orphan), so create is allowed
// to proceed; the no-baseHash reference file is unreadable.
test('R1-3 red: no-baseHash create over an existing unreadable reference file in an orphan skill dir is refused', { skip: SKIP_UNREADABLE }, async () => {
  const fx = await fixture({ refsMode: 0o300, fileMode: 0o000, withSkillMd: false })
  let res
  try {
    res = await applyConclusion({
      action: 'create', skill: 'topic', description: 'Use when working on topic tasks.',
      body: '# topic\nSee references/setup.md.\n', files: [{ path: 'references/setup.md', content: NEW }],
    }, { globalDir: fx.globalDir })
  } finally { await fx.restore() }
  assert.equal(res.result, 'create-conflict', `refused as '${res.result}', not by the unreadable-file guard`)
  assert.equal(await readFile(fx.file, 'utf8'), ORIGINAL, `writer returned '${res.result}' and overwrote an unseen file`)
})

// CONTROL (passes now): the same no-baseHash write over a readable file is refused.
test('R1-3 control: no-baseHash patch over a readable existing reference file is refused', async () => {
  const fx = await fixture({ refsMode: 0o755, fileMode: 0o644 })
  let res
  try {
    res = await applyConclusion(patchNoHash(fx), { globalDir: fx.globalDir })
  } finally { await fx.restore() }
  assert.equal(res.result, 'create-conflict')
  assert.equal(await readFile(fx.file, 'utf8'), ORIGINAL)
})

// CONTROL (passes now): with a baseHash, an unreadable file already fails closed.
test('R1-3 control: baseHash patch over an unreadable reference file is refused (cas-conflict)', { skip: SKIP_UNREADABLE }, async () => {
  const fx = await fixture({ refsMode: 0o755, fileMode: 0o000 })
  let res
  try {
    res = await applyConclusion({ ...patchNoHash(fx), files: [{ path: 'references/setup.md', content: NEW, baseHash: sha256(ORIGINAL) }] }, { globalDir: fx.globalDir })
  } finally { await fx.restore() }
  assert.equal(res.result, 'cas-conflict')
  assert.equal(await readFile(fx.file, 'utf8'), ORIGINAL)
})
