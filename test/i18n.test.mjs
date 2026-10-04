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

/**
 * The zh value upstream actually ships at the site that uses it.
 *
 * Upstream keeps most of these strings inside `runReview`, which it does not
 * export, so they cannot be obtained by calling an upstream function. Asserting
 * them as plain substrings of upstream's source is not enough: the source is
 * ~100 KB of Chinese, so a wrong one-character value ("字" instead of "条",
 * "个", "·") is a substring too, and the check passes on a wrong value. This
 * reads the enclosing string literal out of upstream's own text, so the
 * expected value comes from upstream rather than from the fork.
 */
function upstreamLiteral(anchor, what) {
  const source = readFileSync(UPSTREAM, 'utf8')
  const at = source.indexOf(anchor)
  assert.notEqual(at, -1, `upstream no longer contains ${JSON.stringify(anchor)} (${what})`)
  // Walk back to the opening quote of the literal containing `at`: scan for the
  // nearest quote that starts a string, which is the first one not preceded by a
  // backslash. lastIndexOf alone can land on a previous literal's closing quote.
  let open = source.lastIndexOf("'", at)
  while (open > 0 && source[open - 1] === '\\') open = source.lastIndexOf("'", open - 1)
  const close = source.indexOf("'", at)
  assert.notEqual(close, -1, `unterminated literal for ${what}`)
  return source.slice(open + 1, close).replace(/\\(['"\\])/g, '$1').replace(/\\n/g, '\n')
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

/**
 * The loop-aware section upstream assembles, read back out of its source.
 *
 * Upstream inlines this array inside `apply`, so there is no exported function
 * to call. Parsing the literal out of upstream's own text is still a real check:
 * it compares the fork's array against the array upstream ships, element by
 * element, rather than merely confirming that each line appears somewhere.
 */
function upstreamLoopAware() {
  const source = readFileSync(UPSTREAM, 'utf8')
  const at = source.indexOf("text: [\n            '# 收尾沉淀")
  assert.notEqual(at, -1, 'upstream no longer registers the loop-aware section as an inline array')
  const body = source.slice(at + 'text: ['.length, source.indexOf("].join('\\n')", at))
  return [...body.matchAll(/^\s*'((?:[^'\\]|\\.)*)',?\s*$/gm)].map((m) => m[1].replace(/\\(['"\\])/g, '$1'))
}

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

  // The memory snapshot is injected into every session rather than only into the
  // review agent, so parity is checked over every branch renderMemoryContext has:
  // both stores, one store, an enabled-but-empty store, both empty, and the
  // char limits omitted (which falls through to the store defaults).
  const limits = { memoryCharLimit: 2200, userCharLimit: 1375 }
  const bothEntries = (store) => (store === 'user' ? '§ 偏好：直接给答案' : '§ 端口是 3080')
  const cases = [
    ['both stores, one entry each', { ...limits, memoryEnabled: true, userProfileEnabled: true }, bothEntries],
    ['only memory', { ...limits, memoryEnabled: true, userProfileEnabled: false }, bothEntries],
    ['only user', { ...limits, memoryEnabled: false, userProfileEnabled: true }, bothEntries],
    ['enabled store is empty', { ...limits, memoryEnabled: true, userProfileEnabled: true }, () => ''],
    ['no stores enabled', { ...limits, memoryEnabled: false, userProfileEnabled: false }, bothEntries],
    ['char limits omitted', { memoryEnabled: true, userProfileEnabled: true }, bothEntries],
  ]
  for (const [label, eff, readRaw] of cases) {
    assert.equal(
      I.renderMemoryContext(eff, readRaw),
      upstream().renderMemoryContext(eff, readRaw),
      `fork zh memory snapshot drifted from upstream: ${label}`,
    )
    assert.equal(I.renderMemoryContext(eff, readRaw, 'zh'), upstream().renderMemoryContext(eff, readRaw))
  }

  // And assert undefined explicitly means zh, so no caller needs a sentinel.
  assert.equal(I.reviewPrompt({}), upstream().reviewPrompt({}))

  // The loop-aware section is injected into every session's system prompt and
  // upstream does not export it, so compare against the array it assembles —
  // read back out of upstream's source, not asserted as a substring of it.
  assert.deepEqual(I.LOOP_AWARE_TEXT.zh, upstreamLoopAware(), 'fork zh loop-aware section drifted from upstream')
  assert.equal(I.LOOP_AWARE_TEXT.zh.join('\n'), upstreamLoopAware().join('\n'))

  // Every remaining zh value is compared against the literal at the exact
  // upstream site that uses it, so a wrong one-character value cannot pass.
  const inUpstream = (actual, anchor, what) =>
    assert.equal(actual, upstreamLiteral(anchor, what), `not upstream's text — ${what}`)
  inUpstream(I.REVIEW_INPUT_TEXT.zh.emptyCatalog, '（当前无可用 skill）', 'empty-catalog fallback')
  inUpstream(I.REVIEW_INPUT_TEXT.zh.truncated, '…（截断）', 'suspect truncation marker')
  inUpstream(I.MEMORY_CONTEXT_TEXT.zh.heading, '# 长期记忆（跨会话持久', 'memory snapshot heading')
  inUpstream(I.MEMORY_CONTEXT_TEXT.zh.userTitle, 'USER（用户画像/偏好）', 'user store title')
  inUpstream(I.MEMORY_CONTEXT_TEXT.zh.memoryTitle, 'MEMORY（环境/项目事实/约定/教训）', 'memory store title')
  inUpstream(`\n## ${I.REVIEW_MEMORY_BLOCK_TEXT.zh.section}\n`, '## 当前记忆条目（oldText', 'review memory block heading')
  inUpstream(`\n## ${I.REVIEW_INPUT_TEXT.zh.catalog}\n`, '## 既有 skill 清单（name: description）', 'catalog heading')
  inUpstream(`\n## ${I.REVIEW_INPUT_TEXT.zh.suspects}\n`, '## 疑似相关 skill 全文', 'suspects heading')
  inUpstream(`\n## ${I.REVIEW_INPUT_TEXT.zh.transcript}\n`, '## 会话转写（保尾截断）', 'transcript heading')

  // The short separators are written inline by upstream's templates rather than
  // stored as literals, so they are pinned against the templates themselves:
  // upstream's memory-block line must still contain exactly these pieces, or the
  // dictionary's parens/items would be rendering something upstream never wrote.
  assert.ok(
    readFileSync(UPSTREAM, 'utf8').includes('}（${entries.length} 条）\\n'),
    'upstream no longer writes the memory-block count as （${entries.length} 条）',
  )
  assert.ok(
    readFileSync(UPSTREAM, 'utf8').includes("'（推理中）'"),
    'upstream no longer prefixes reasoning previews with （推理中）',
  )
  assert.equal(I.REVIEW_MEMORY_BLOCK_TEXT.zh.open + I.REVIEW_MEMORY_BLOCK_TEXT.zh.items + I.REVIEW_MEMORY_BLOCK_TEXT.zh.close, '（条）')
  assert.equal(I.REVIEW_MEMORY_BLOCK_TEXT.zh.empty, '（空）')
  assert.equal(I.REVIEW_INPUT_TEXT.zh.reasoning, '（推理中）')
  // `字符` and ` 条` are inline fragments of upstream's snapshot template.
  assert.ok(
    readFileSync(UPSTREAM, 'utf8').includes('${memoryStoreLimit(store, eff)} 字符 · ${entries.length} 条'),
    'upstream no longer writes the snapshot count as 字符 · … 条',
  )
  assert.equal(I.MEMORY_CONTEXT_TEXT.zh.chars, '字符')
  assert.equal(I.MEMORY_CONTEXT_TEXT.zh.items, '条')

  // The memory block is assembled by a template upstream writes inline, so the
  // rendered zh line is compared against that template's own text. This is what
  // pins the count's spacing and its full-width parentheses: checking the
  // dictionary values alone would not notice a template that dropped the space.
  const block = I.renderReviewMemoryBlock([{ store: 'user', entries: ['a', 'b'] }, { store: 'memory', entries: [] }], 'zh')
  assert.equal(
    block,
    upstreamLiteral('## 当前记忆条目（oldText', 'memory block')
    + '### USER（2 条）\n§ a\n§ b\n\n'
    + '### MEMORY（0 条）\n（空）',
    'fork zh review memory block drifted from the template upstream writes',
  )
  assert.ok(
    readFileSync(UPSTREAM, 'utf8').includes('}（${entries.length} 条）'),
    'upstream no longer renders the memory-block count as （${entries.length} 条）',
  )
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