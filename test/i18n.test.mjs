/**
 * Local fork tests: the review prompt, the memory snapshot, and the loop-aware
 * section follow the durable locale preference, and an unset preference is
 * byte-identical to upstream 0.1.16.
 *
 * The "byte-identical" assertions are the load-bearing ones. They are what
 * makes the fork safe to install for a user who never touches Settings →
 * Language: it must behave exactly like the package it replaces.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fork = createRequire(import.meta.url)(join(root, 'src/index.js'))
const { __internals: I } = fork

// The pristine upstream copy this fork was cut from, used as the oracle. Its
// reviewPrompt is not exported, so the source is evaluated through a CommonJS
// require with one appended export line rather than re-deriving its behaviour
// from its text. `createRequire` keeps this CommonJS-safe even though this test
// file is an ES module.
//
// Resolved from node_modules so the oracle travels with the checkout instead of
// pointing at one developer's dsh profile: if the package is not installed the
// parity tests skip rather than silently passing against nothing.
const UPSTREAM = join(root, 'node_modules', '@weibaohui', 'hermes-loop', 'src', 'index.js')
const haveUpstream = existsSync(UPSTREAM)
const oracle = { skip: haveUpstream ? false : '@weibaohui/hermes-loop is not installed' }

function loadUpstream() {
  const source = readFileSync(UPSTREAM, 'utf8').replace(
    /\n\}\s*$/,
    '\n}\nmodule.exports.__internals.reviewPrompt = reviewPrompt\n',
  )
  const module_ = { exports: {} }
  new Function('module', 'exports', 'require', '__dirname', '__filename', source)(
    module_, module_.exports, createRequire(UPSTREAM), dirname(UPSTREAM), UPSTREAM,
  )
  return module_.exports.__internals
}

// Lazy, so a checkout without the oracle skips instead of failing at import.
let U
function upstream() {
  return (U ??= loadUpstream())
}

/** Every zh dictionary value must be text upstream actually wrote. */
function upstreamSource() {
  return readFileSync(UPSTREAM, 'utf8').replace(/\\(['"])/g, '$1')
}

/** A settings service stub whose `locale` descriptor carries `value.preference`. */
function settingsWith(preference, { present = true } = {}) {
  return {
    settings: {
      describe: () => (present
        ? [{ ns: 'locale', value: preference === undefined ? {} : { preference } }]
        : []),
    },
  }
}

test('languageOf collapses locale ids onto the two carried languages', () => {
  assert.equal(I.languageOf('en'), 'en')
  assert.equal(I.languageOf('EN'), 'en')
  assert.equal(I.languageOf('en-US'), 'en')
  assert.equal(I.languageOf('en-GB-oxendict'), 'en')
  assert.equal(I.languageOf('zh'), 'zh')
  assert.equal(I.languageOf('zh-CN'), 'zh')
  assert.equal(I.languageOf(undefined), 'zh')
  assert.equal(I.languageOf(''), 'zh')
})

test('readLocalePreference distinguishes unset from unreadable', () => {
  // An explicit choice, seen.
  assert.deepEqual(I.readLocalePreference(settingsWith('en'), null), { value: 'en', seen: true })
  assert.deepEqual(I.readLocalePreference(settingsWith('zh-CN'), null), { value: 'zh-cn', seen: true })

  // A readable document with no preference is "seen, unset" — NOT an error.
  assert.deepEqual(I.readLocalePreference(settingsWith(undefined), null), { value: undefined, seen: true })

  // Values the client would not treat as a locale are ignored, not trusted.
  assert.deepEqual(I.readLocalePreference(settingsWith('e n'), null), { value: undefined, seen: true })
  assert.deepEqual(I.readLocalePreference(settingsWith(42), null), { value: undefined, seen: true })

  // No document at all: the settings entry has not mounted yet.
  assert.deepEqual(I.readLocalePreference(settingsWith('en', { present: false }), null), { value: undefined, seen: false })
  assert.deepEqual(I.readLocalePreference({}, null), { value: undefined, seen: false })
  assert.deepEqual(I.readLocalePreference({ settings: { describe () { throw new Error('boom') } } }, null), { value: undefined, seen: false })
})

test('the default language is upstream 0.1.16, verified by running upstream', oracle, () => {
  // The load-bearing assertion: with no preference recorded, this fork must
  // produce exactly what the package it replaces produced. Comparing against
  // upstream's own function catches any drift in the zh branch itself.
  for (const eff of [
    { memoryEnabled: true, userProfileEnabled: true },
    { memoryEnabled: true, userProfileEnabled: false },
    { memoryEnabled: false, userProfileEnabled: true },
    { memoryEnabled: false, userProfileEnabled: false },
    {},
  ]) {
    assert.equal(I.reviewPrompt(eff), upstream().reviewPrompt(eff), `fork zh drifted from upstream for ${JSON.stringify(eff)}`)
    assert.equal(I.reviewPrompt(eff, 'zh'), upstream().reviewPrompt(eff))
  }

  // Also pin the memory snapshot, which is the surface injected into every
  // session's context rather than only into the review agent.
  const eff = { memoryEnabled: true, userProfileEnabled: true, memoryCharLimit: 2200, userCharLimit: 1375 }
  const readRaw = (store) => (store === 'user' ? '§ 偏好：直接给答案' : '§ 端口是 3080')
  assert.equal(I.renderMemoryContext(eff, readRaw), upstream().renderMemoryContext(eff, readRaw))
  assert.equal(I.renderMemoryContext(eff, readRaw, 'zh'), upstream().renderMemoryContext(eff, readRaw))

  // And assert undefined explicitly means zh, so no caller needs a sentinel.
  assert.equal(I.reviewPrompt({}), upstream().reviewPrompt({}))

  // No fork-only Chinese may exist in the dictionaries: each zh value must be
  // text upstream's own source contains, verbatim. Substring, not a parsed
  // literal, because upstream mixes quoted strings with template literals.
  const source = upstreamSource()
  const inUpstream = (text) => assert.ok(source.includes(text), `not upstream text: ${text}`)
  for (const value of Object.values(I.MEMORY_CONTEXT_TEXT.zh)) inUpstream(value)
  for (const value of I.LOOP_AWARE_TEXT.zh) inUpstream(value)
  for (const value of Object.values(I.REVIEW_INPUT_TEXT.zh)) inUpstream(value)
  for (const value of Object.values(I.REVIEW_MEMORY_BLOCK_TEXT.zh)) inUpstream(value)
})

test('the memory snapshot renders in the chosen language', () => {
  const eff = { memoryEnabled: true, userProfileEnabled: true, memoryCharLimit: 2200, userCharLimit: 1375 }
  const readRaw = (store) => (store === 'user' ? '§ 用户偏好：回答直接给结论' : '§ 服务跑在 3080 端口')
  // Entry text is user-authored and is never translated; only framing is.
  const en = I.renderMemoryContext(eff, readRaw, 'en')
  const zh = I.renderMemoryContext(eff, readRaw, 'zh')

  assert.match(en, /^# Long-term memory/)
  assert.match(en, /## USER \(user profile \/ preferences\)/)
  assert.match(en, /## MEMORY \(environment facts/)
  assert.match(en, /1 entries/)
  assert.ok(en.includes('服务跑在 3080 端口'), 'entry text must survive untouched')

  assert.match(zh, /^# 长期记忆/)
  assert.match(zh, /1 条/)
})

test('the review prompt switches wholesale and keeps its contract', () => {
  const eff = { memoryEnabled: true, userProfileEnabled: true }
  const en = I.reviewPrompt(eff, 'en')
  const zh = I.reviewPrompt(eff, 'zh')

  assert.match(en, /^You are the background review agent/)
  assert.match(en, /## Wrap-up distillation|## Positive signals/)
  assert.ok(!/[一-鿿]/.test(en), 'the English prompt must contain no Chinese')

  // Both branches must expose the same machine-readable contract, or the
  // conclusion parser silently starts rejecting results.
  for (const text of [en, zh]) {
    for (const field of ['"action"', '"skill"', '"description"', '"body"', '"baseHash"', '"baseDescription"', '"rationale"', '"memory"', '"store"', '"oldText"']) {
      assert.ok(text.includes(field), `output contract field missing: ${field}`)
    }
    assert.ok(text.includes('When to Use / Prerequisites / Procedure / Pitfalls / Verification'))
  }
})

test('the memory block drops its section when both stores are off, in both languages', () => {
  const off = { memoryEnabled: false, userProfileEnabled: false }
  assert.ok(!I.reviewPrompt(off, 'en').includes('"memory"'))
  assert.ok(!I.reviewPrompt(off, 'zh').includes('"memory"'))
  assert.match(I.reviewPrompt(off, 'en'), /not distilled this round/)
})