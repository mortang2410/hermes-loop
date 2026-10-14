import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// Same guard as test/loop.test.mjs: plugin state goes to a temp dir, not the real ~/.dsh.
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'r1-6-home-'))

// R1-6. Expected behaviour (design: m6rf report, decisions 2 and 5):
//  - decision 5: a file with no baseHash must not exist yet, or the result is
//    create-conflict. All files are checked before any write, so a refusal
//    leaves no partial write.
//  - decision 2: the reference set is not atomic across files, so an earlier
//    failed write can leave an unreferenced reference file. That leftover is
//    not adopted: nothing marks it as the writer's own, so it is refused like
//    any other existing file.
// Setup: a skill directory with references/n.md and no SKILL.md, the state a
// failed create leaves behind. Written directly so the test does not depend on
// file permissions (root ignores them).

const require = createRequire(import.meta.url)
const plugin = require('../src/index.js')
const { applyConclusion } = plugin.__internals

async function skillWithOrphan(dir) {
  await mkdir(join(dir, 'fresh-x', 'references'), { recursive: true })
  await writeFile(join(dir, 'fresh-x', 'references', 'n.md'), 'orphan v1\n')
}

test('R1-6: a create refuses an existing reference file when SKILL.md is absent, and writes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'r1-6-'))
  try {
    await skillWithOrphan(dir)
    const out = await applyConclusion({
      action: 'create', skill: 'fresh-x', description: 'd', body: 'body v1',
      files: [{ path: 'references/n.md', content: 'note v2\n' }],
    }, { globalDir: dir })
    assert.equal(out.result, 'create-conflict')
    assert.match(out.detail, /references\/n\.md/, 'the detail must name the clashing file')
    assert.equal(await readFile(join(dir, 'fresh-x', 'references', 'n.md'), 'utf8'), 'orphan v1\n', 'the existing file must not be overwritten')
    await assert.rejects(stat(join(dir, 'fresh-x', 'SKILL.md')), { code: 'ENOENT' })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('R1-6: a refused create writes none of its other new files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'r1-6-'))
  try {
    await skillWithOrphan(dir)
    const out = await applyConclusion({
      action: 'create', skill: 'fresh-x', description: 'd', body: 'body v1',
      files: [
        { path: 'references/n.md', content: 'note v2\n' },
        { path: 'references/m.md', content: 'other\n' },
      ],
    }, { globalDir: dir })
    assert.equal(out.result, 'create-conflict')
    assert.deepEqual(await readdir(join(dir, 'fresh-x', 'references')), ['n.md'], 'no partial write')
    assert.deepEqual(await readdir(join(dir, 'fresh-x')), ['references'], 'no SKILL.md')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('R1-6: a create that names no existing file still lands while the orphan stays untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'r1-6-'))
  try {
    await skillWithOrphan(dir)
    const out = await applyConclusion({
      action: 'create', skill: 'fresh-x', description: 'd', body: 'body v1',
      files: [{ path: 'references/m.md', content: 'other\n' }],
    }, { globalDir: dir })
    assert.equal(out.result, 'created')
    assert.equal(await readFile(join(dir, 'fresh-x', 'references', 'n.md'), 'utf8'), 'orphan v1\n', 'the orphan is not touched')
    assert.equal(await readFile(join(dir, 'fresh-x', 'references', 'm.md'), 'utf8'), 'other\n')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
