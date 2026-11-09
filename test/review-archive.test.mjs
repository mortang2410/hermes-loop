/**
 * Review-session archiving: a finished review agent's session directory leaves the
 * live session store and lands in the archive with its log intact.
 *
 * The live store is what session/list walks, and 1,476 `hermes-loop-review-*`
 * directories had accumulated there before this behaviour existed. The assertions
 * that matter are the two-sided ones: the store no longer holds the directory, and
 * the archive holds it with the same bytes, so nothing is lost by the move.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const plugin = createRequire(import.meta.url)(join(root, 'src/index.js'))
const { __internals: I } = plugin

const REVIEW_ID = 'hermes-loop-review-11111111-2222-3333-4444-555555555555'

/** Run one case against a throwaway DSH home and restore the caller's value. */
async function withHome(run) {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-review-archive-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    await run(dir)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a finished review session moves to the archive with its log', async () => {
  await withHome(async (home) => {
    const store = join(home, 'sessions', '--home-wilder-project--', REVIEW_ID)
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, 'session.v4.jsonl.zstd'), 'log-bytes')
    writeFileSync(join(store, 'session.lock'), '')

    await I.archiveReviewSessionDir(REVIEW_ID)

    assert.equal(existsSync(store), false, 'the live store no longer holds the review session')
    const archived = join(home, 'hermes-loop', 'review-archive', '--home-wilder-project--', REVIEW_ID)
    assert.equal(readFileSync(join(archived, 'session.v4.jsonl.zstd'), 'utf8'), 'log-bytes')
    assert.ok(existsSync(join(archived, 'session.lock')), 'the whole directory travelled, not only the log')
  })
})

test('a user session id is never archived', async () => {
  await withHome(async (home) => {
    const id = 'session-11111111-2222-3333-4444-555555555555'
    const store = join(home, 'sessions', '--home-wilder-project--', id)
    mkdirSync(store, { recursive: true })

    await I.archiveReviewSessionDir(id)

    assert.ok(existsSync(store), 'a session the user can open stays in the live store')
    assert.equal(existsSync(join(home, 'hermes-loop', 'review-archive')), false)
  })
})

test('a review session already gone from the store is a no-op', async () => {
  await withHome(async (home) => {
    mkdirSync(join(home, 'sessions', '--home-wilder-project--'), { recursive: true })

    await I.archiveReviewSessionDir(REVIEW_ID)

    assert.equal(existsSync(join(home, 'hermes-loop', 'review-archive')), false)
  })
})

test('an absent store is a no-op rather than a throw', async () => {
  await withHome(async () => {
    await I.archiveReviewSessionDir(REVIEW_ID)
  })
})
