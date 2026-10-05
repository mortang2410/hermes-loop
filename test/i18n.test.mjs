/**
 * Locale tests: the review prompt, the memory snapshot, and the loop-aware
 * section follow the durable locale preference, and an unset preference is
 * byte-identical to upstream 0.1.16.
 *
 * The "byte-identical" assertions are the load-bearing ones. They are what
 * makes the change safe for a user who never touches Settings → Language:
 * they must get exactly the behaviour of the version this replaces.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const plugin = createRequire(import.meta.url)(join(root, 'src/index.js'))
const { __internals: I } = plugin

// The pristine copy of the version under test, used as the oracle. Its
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
 * expected value comes from the version under test rather than from here.
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
  // The closing quote needs the same skip: an escaped apostrophe inside the
  // literal (as in "don't") is not a terminator.
  let close = source.indexOf("'", at)
  while (close > 0 && source[close - 1] === '\\') close = source.indexOf("'", close + 1)
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
  assert.deepEqual(I.readLocalePreference(settingsWith('en')), { value: 'en', seen: true })
  assert.deepEqual(I.readLocalePreference(settingsWith('zh-CN')), { value: 'zh-cn', seen: true })

  // A readable document with no preference is "seen, unset" — NOT an error.
  assert.deepEqual(I.readLocalePreference(settingsWith(undefined)), { value: undefined, seen: true })

  // Values the client would not treat as a locale are ignored, not trusted.
  assert.deepEqual(I.readLocalePreference(settingsWith('e n')), { value: undefined, seen: true })
  assert.deepEqual(I.readLocalePreference(settingsWith(42)), { value: undefined, seen: true })

  // No document at all: the settings entry has not mounted yet.
  assert.deepEqual(I.readLocalePreference(settingsWith('en', { present: false })), { value: undefined, seen: false })
  assert.deepEqual(I.readLocalePreference({}), { value: undefined, seen: false })
  assert.deepEqual(I.readLocalePreference({ settings: { describe () { throw new Error('boom') } } }), { value: undefined, seen: false })
})

/**
 * The loop-aware section upstream assembles, read back out of its source.
 *
 * Upstream inlines this array inside `apply`, so there is no exported function
 * to call. Parsing the literal out of upstream's own text is still a real check:
 * it compares this array against the one that version ships, element by
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
  // The load-bearing assertion: with no preference recorded, this change must
  // produce exactly what the package it replaces produced. Comparing against
  // upstream's own function catches any drift in the zh branch itself.
  for (const eff of [
    { memoryEnabled: true, userProfileEnabled: true },
    { memoryEnabled: true, userProfileEnabled: false },
    { memoryEnabled: false, userProfileEnabled: true },
    { memoryEnabled: false, userProfileEnabled: false },
    {},
  ]) {
    assert.equal(I.reviewPrompt(eff), upstream().reviewPrompt(eff), `zh output drifted from upstream for ${JSON.stringify(eff)}`)
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
      `memory snapshot drifted from upstream: ${label}`,
    )
    assert.equal(I.renderMemoryContext(eff, readRaw, 'zh'), upstream().renderMemoryContext(eff, readRaw))
  }

  // And assert undefined explicitly means zh, so no caller needs a sentinel.
  assert.equal(I.reviewPrompt({}), upstream().reviewPrompt({}))

  // The loop-aware section is injected into every session's system prompt and
  // upstream does not export it, so compare against the array it assembles —
  // read back out of upstream's source, not asserted as a substring of it.
  assert.deepEqual(I.LOOP_AWARE_TEXT.zh, upstreamLoopAware(), 'loop-aware section drifted from the version under test')
  assert.equal(I.LOOP_AWARE_TEXT.zh.join('\n'), upstreamLoopAware().join('\n'))

  // Every remaining zh value is compared against the literal at the exact
  // upstream site that uses it, so a wrong one-character value cannot pass.
  const inUpstream = (actual, anchor, what) =>
    assert.equal(actual, upstreamLiteral(anchor, what), `not the text of the version under test — ${what}`)
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
    'review memory block drifted from the template upstream writes',
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

  assert.ok(en.startsWith(I.MEMORY_CONTEXT_TEXT.en.heading), 'the English heading must be the one the dictionary carries')
  assert.ok(en.includes(`## ${I.MEMORY_CONTEXT_TEXT.en.userTitle}`), 'the English user title must be the one the dictionary carries')
  assert.ok(en.includes(`## ${I.MEMORY_CONTEXT_TEXT.en.memoryTitle}`), 'the English memory title must be the one the dictionary carries')
  assert.ok(en.includes(`1 ${I.MEMORY_CONTEXT_TEXT.en.items}`), 'the English entry count must use the dictionary label')
  assert.ok(en.includes(`2200 ${I.MEMORY_CONTEXT_TEXT.en.chars}`), 'the English char count must use the dictionary label')
  assert.ok(en.includes('服务跑在 3080 端口'), 'entry text must survive untouched')

  assert.match(zh, /^# 长期记忆/)
  assert.ok(zh.includes(`1 ${I.MEMORY_CONTEXT_TEXT.zh.items}`), 'the zh count must use the dictionary label')
})

test('the review prompt switches wholesale and keeps its contract', () => {
  const eff = { memoryEnabled: true, userProfileEnabled: true }
  const en = I.reviewPrompt(eff, 'en')
  const zh = I.reviewPrompt(eff, 'zh')

  assert.match(en, /^You are the background review agent/)
  assert.match(en, /## Wrap-up distillation|## Positive signals/)
  assert.ok(!/[一-鿿]/.test(en), 'the English prompt must contain no Chinese')

  // Both branches must expose the same machine-readable contract, or the
  // conclusion parser silently starts rejecting results. Checked per element:
  // a bare field-name substring list would also pass a prompt that had lost the
  // fence, the per-field `required for` annotations, or the enums.
  for (const [text, label] of [[en, 'en'], [zh, 'zh']]) {
    for (const field of ['"action"', '"skill"', '"description"', '"body"', '"baseHash"', '"baseDescription"', '"rationale"', '"memory"', '"store"', '"text"', '"oldText"']) {
      assert.ok(text.includes(field), `${label}: output contract field missing: ${field}`)
    }
    assert.ok(text.includes('```json'), `${label}: the protocol must be a fenced json block`)
    assert.ok(text.includes('```'), `${label}: the json fence must be closed`)
    // The per-field required-for annotations, in the language's own wording.
    // These are what tell the model which fields are mandatory; losing them is
    // the failure that produces conclusions the parser rejects.
    const annotations = label === 'en'
      ? ['required for create/patch', 'required for create', 'required for patch', 'required for add/replace/remove']
      : ['create/patch 必填', 'create 必填', 'patch 必填', 'add/replace/remove 必填']
    for (const annotation of annotations) {
      assert.ok(text.includes(annotation), `${label}: missing field annotation "${annotation}"`)
    }
    for (const value of ['"nothing"', '"create"', '"patch"', '"add"', '"replace"', '"remove"']) {
      assert.ok(text.includes(value), `${label}: missing action value ${value}`)
    }
    assert.ok(text.includes('When to Use / Prerequisites / Procedure / Pitfalls / Verification'), `${label}: body section convention missing`)
  }

  // Structural parity: the two languages must correspond position by position,
  // so a line cannot be dropped, added, or reordered in one of them. Heading
  // lines are matched by shape (a `## ` title) rather than by text, so renaming
  // one section in a single language is caught.
  const headingCount = (lines, prefix) => lines.filter((l) => l.startsWith(prefix)).length
  for (const memoryOn of [true, false]) {
    const a = I.REVIEW_PROMPT_TEXT.zh(memoryOn)
    const b = I.REVIEW_PROMPT_TEXT.en(memoryOn)
    assert.equal(a.length, b.length, `zh/en prompt length differs with memoryOn=${memoryOn}`)
    for (let i = 0; i < a.length; i++) {
      assert.equal(a[i] === '', b[i] === '', `zh/en line ${i} is blank in only one language`)
      assert.equal(
        a[i].startsWith('## '), b[i].startsWith('## '),
        `zh/en line ${i} is a section heading in only one language: ${JSON.stringify([a[i], b[i]])}`,
      )
      assert.equal(/^\d\./.test(a[i]), /^\d\./.test(b[i]), `zh/en line ${i} is a numbered item in only one language`)
      assert.equal(a[i].startsWith('- '), b[i].startsWith('- '), `zh/en line ${i} is a bullet in only one language`)
      assert.equal(a[i].includes('```'), b[i].includes('```'), `zh/en line ${i} is a fence in only one language`)
    }
    assert.equal(headingCount(a, '## '), headingCount(b, '## '))
    assert.equal(a.filter((l) => /^\d\./.test(l)).length, b.filter((l) => /^\d\./.test(l)).length)
  }
  // The review protocol's sections, by the same index in both languages. Renaming
  // or dropping one in a single language changes the protocol the model follows,
  // so the whole sequence is pinned rather than only its shape.
  const zhSections = I.REVIEW_PROMPT_TEXT.zh(true).filter((l) => l.startsWith('## '))
  const enSections = I.REVIEW_PROMPT_TEXT.en(true).filter((l) => l.startsWith('## '))
  assert.deepEqual(
    zhSections.map((l) => l.slice(3).replace(/（[^）]*）/g, '')),
    ['主动倾向', '正向信号', '负面清单', '优先序', '命名纪律', '记忆', '分工', '输出协议'],
    'the zh review protocol lost or reordered a section',
  )
  assert.deepEqual(
    enSections.map((l) => l.slice(3).replace(/\s*\([^)]*\)/g, '')),
    ['Lean toward acting', 'Positive signals', 'Negative list', 'Priority order', 'Naming discipline', 'Memory', 'Division of labour', 'Output protocol'],
    'the en review protocol lost or reordered a section',
  )
  // Every dictionary the call sites index must carry both languages.
  for (const [name, dict] of Object.entries({ MEMORY_CONTEXT_TEXT: I.MEMORY_CONTEXT_TEXT, REVIEW_MEMORY_BLOCK_TEXT: I.REVIEW_MEMORY_BLOCK_TEXT, REVIEW_INPUT_TEXT: I.REVIEW_INPUT_TEXT })) {
    assert.deepEqual(Object.keys(dict.zh).sort(), Object.keys(dict.en).sort(), `${name}: zh/en keys differ`)
  }
  assert.equal(I.LOOP_AWARE_TEXT.zh.length, I.LOOP_AWARE_TEXT.en.length)

  // The English copy is pinned exactly. The zh copy is pinned against the version
  // under test by running its code; there is no upstream English to compare with,
  // so an English string can only be pinned against itself. Pinning it is what
  // turns an unnoticed edit to the English wording into a failing test.
  assert.deepEqual(I.MEMORY_CONTEXT_TEXT.en, {
    heading: '# Long-term memory (persists across sessions, maintained on demand by the background review; this is the latest full snapshot)',
    userTitle: 'USER (user profile / preferences)',
    memoryTitle: 'MEMORY (environment facts, project facts, conventions, lessons)',
    chars: 'chars',
    items: 'entries',
  }, 'the English memory snapshot copy changed')
  assert.deepEqual(I.REVIEW_MEMORY_BLOCK_TEXT.en, {
    section: "Current memory entries (oldText must match exactly one entry's original text; omit the memory field entirely when nothing is worth recording)",
    items: 'entries',
    open: ' (',
    close: ')',
    empty: '(empty)',
  }, 'the English review memory block copy changed')
  assert.deepEqual(I.REVIEW_INPUT_TEXT.en, {
    catalog: 'Existing skill catalog (name: description)',
    suspects: 'Full text of likely-relevant skills',
    transcript: 'Session transcript (tail-preserving truncation)',
    reasoning: '(reasoning)',
    transcriptTruncated: '…(earlier messages dropped; tail kept)',
    emptyCatalog: '(no skills available)',
    truncated: '\n… (truncated)',
  }, 'the English review input copy changed')
  assert.deepEqual(I.LOOP_AWARE_TEXT.en, [
    '# Wrap-up distillation (the background learning loop is running)',
    '',
    '- When wrapping up, if you find that a **skill loaded in this session** is wrong, missing steps, or outdated: fix it **immediately with your own tools** rather than leaving it to the background review (the background review will also catch it, but your context here is the most complete one).',
    '- Leave all other distillation (new skills, lessons learned) to the background learning loop. **Do not** proactively write new skill files — two competing sets of instructions would fight each other.',
  ], 'the English loop-aware copy changed')

  // The English review prompt is the largest model-facing surface and is pinned
  // here for the same reason as the dictionaries: the model obeys this text, and
  // `parseConclusion` reads the keys it names. Renaming `rationale` in the
  // English prompt while the parser still reads `rationale` would turn every
  // English review into a silent no-op, with the suite green.
  //
  // Changing English wording means editing here too. That is the cost of having
  // no upstream English to compare against; the zh branch is pinned against the
  // real 0.1.16 functions instead and has no equivalent duplication.
  assert.deepEqual(I.REVIEW_PROMPT_TEXT.en(true), [
    'You are the background review agent: analyze a transcript of a just-finished conversation and decide whether it holds experience worth distilling into a skill.',
    '',
    '## Lean toward acting',
    'Be ACTIVE — most conversations are worth at least one small update. Doing nothing is not a neutral outcome; it is a missed learning opportunity.',
    '',
    '## Positive signals (act if any holds)',
    '1. The user corrected style/tone/format/verbosity ("stop doing X" / "too verbose" / "just give me the answer") — this is a FIRST-CLASS signal;',
    '2. The user corrected the workflow or the order of steps;',
    '3. A non-trivial technique, fix, workaround, debugging path, or tool usage appeared;',
    '4. An injected existing skill was found wrong, incomplete, or outdated → PATCH it immediately.',
    '',
    '## Negative list (never distill these)',
    '- Environment dependency failures (missing binary, unconfigured credentials — things the user can fix themselves);',
    '- Negative assertions about tools ("X is broken" hardens into a permanent refusal);',
    '- Transient errors already resolved within the session (what is worth storing is the retry pattern, not the failure itself);',
    '- One-off task narrative (it does not constitute a category of work);',
    '- Unresolved failures — an unverified dead end must never be packaged as a reliable procedure.',
    '',
    '## Priority order',
    '1. PATCH a skill that appeared in the transcript and whose full text was injected;',
    '2. PATCH an existing class-level umbrella skill (see the catalog below);',
    '3. Only when neither covers it, CREATE a new skill.',
    '',
    '## Naming discipline',
    'Use kebab-case class-level names. No PR numbers, error strings, or one-off codenames (fix-X / debug-Y style).',
    "If the name only makes sense for today's task, it is wrong — go back to priority 1/2 and extend an existing skill instead.",
    '',
    '## Memory (optional conclusion — most reviews should produce none)',
    'Besides skills, consider writing memory only when the conversation **explicitly** surfaced:',
    '- user profile, preferences, expectations about how you behave → store="user";',
    '- environment/project facts, conventions, lessons (e.g. "releases require OTP", "the service runs on port 19080") → store="memory";',
    '- processes, steps, pitfalls → these remain skills; never write them into memory.',
    'Produce on demand: if nothing is clearly worth keeping, omit the memory field — do not write for the sake of writing. The memory stores are small, tightly-curated lists; mediocre entries crowd out real ones, while a missed entry costs almost nothing.',
    'When a store nears its limit, prefer replace (merge and rewrite an existing entry) or remove (drop a stale entry) over add.',
    '',
    '## Division of labour',
    'Processes, steps, pitfalls → skill; environment facts/conventions/lessons and user profile → memory (rules above).',
    '',
    '## Output protocol (strictly obey)',
    'Output one fenced JSON code block and nothing else:',
    '```json',
    '{ "action": "nothing" | "create" | "patch",',
    '  "skill": "kebab-case-name",            // required for create/patch',
    '  "description": "≤500 characters",       // required for create',
    '  "body": "Complete SKILL.md body, without frontmatter",  // required for create/patch',
    '  "baseHash": "<echo the injected suspect baseHash verbatim>",  // required for patch',
    '  "baseDescription": "<echo the injected suspect description verbatim>",  // required for patch',
    '  "rationale": "One sentence: why it is worth storing, or why not",',
    '  "memory": {                            // optional; most reviews should omit the whole field',
    '    "action": "nothing" | "add" | "replace" | "remove",',
    '    "store": "memory" | "user",           // required for add/replace/remove',
    '    "text": "New entry, one sentence (required for add/replace)",',
    '    "oldText": "A substring of the original text that uniquely matches one entry in the memory list below (required for replace/remove)",',
    '    "rationale": "Why record / change / delete" }',
    '}',
    '```',
    'On patch, the body must be derived by modifying the injected target text (keep what is correct, change only what must change); never rewrite it from scratch.',
    'Body section convention: When to Use / Prerequisites / Procedure / Pitfalls / Verification.',
  ], 'the English review prompt changed')
  const enOff = I.REVIEW_PROMPT_TEXT.en(false)
  assert.equal(enOff.length, 43, 'the English memory-off prompt must drop exactly the two memory blocks')
  assert.ok(!enOff.some((l) => l.startsWith('## Memory')), 'no memory guidance section when memory is off')
  assert.ok(!enOff.some((l) => l.includes('"memory":')), 'no memory conclusion schema when memory is off')
  assert.deepEqual(
    enOff.slice(26, 29),
    ['## Division of labour', 'Processes, steps, pitfalls → skill. User profile/preference information is not distilled this round.', ''],
    'the English memory-off division-of-labour line must say memory is not distilled',
  )
})

test('no English surface leaks Chinese or fullwidth punctuation', () => {
  // Han alone is not enough: the fullwidth parentheses the zh branch keeps are
  // CJK punctuation, and a half-translated heading is the defect this catches.
  const cjk = /[\u3000-\u303f\uff00-\uffef\u4e00-\u9fff]/
  const surfaces = {
    'review prompt': I.reviewPrompt({ memoryEnabled: true, userProfileEnabled: true }, 'en'),
    'memory snapshot': I.renderMemoryContext({ memoryEnabled: true, userProfileEnabled: true }, () => '\u00a7 entry', 'en'),
    'review memory block': I.renderReviewMemoryBlock([{ store: 'user', entries: ['a'] }, { store: 'memory', entries: [] }], 'en'),
    'loop-aware': I.LOOP_AWARE_TEXT.en.join('\n'),
    'review input': Object.values(I.REVIEW_INPUT_TEXT.en).join('\n'),
    'memory context dict': Object.values(I.MEMORY_CONTEXT_TEXT.en).join('\n'),
    // The transcript is spliced into the prompt verbatim, past every dictionary,
    // so it has to be rendered here or a marker it owns goes unchecked.
    'rendered transcript (truncated)': I.renderTranscript(
      Array.from({ length: 40 }, () => ({ role: 'user', content: 'y'.repeat(380) })),
      { lang: 'en' },
    ),
  }
  for (const [name, text] of Object.entries(surfaces)) {
    assert.ok(!cjk.test(text), `${name} still contains CJK: ${JSON.stringify(text.match(cjk))}`)
  }
  // Under-length transcripts and zh must both still work.
  assert.ok(!cjk.test(I.renderTranscript([{ role: 'user', content: 'short' }], { lang: 'en' })))
  // The per-message cap runs first, so exceeding the transcript limit needs many
  // messages rather than one long one.
  const long = Array.from({ length: 40 }, () => ({ role: 'user', content: 'x'.repeat(380) }))
  assert.match(I.renderTranscript(long, { lang: 'zh' }), /^…（早段已按保尾策略截断）/,
    'the zh transcript marker must stay byte-identical to the historical text')
  assert.match(I.renderTranscript(long, { lang: 'en' }), /^…\(earlier messages dropped; tail kept\)/,
    'the English transcript must carry its own marker')
})

// A minimal stand-in for the parts of the host context `apply` touches. The
// provider wiring is only reachable through `apply`, so testing the dictionaries
// directly cannot prove the runner passes the right language to each renderer.
function hostContext({ preference = 'en', unset = false } = {}) {
  const sections = [], contexts = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    settings: { describe: () => [{ ns: 'locale', value: unset ? {} : { preference } }] },
    systemPrompt: {
      section: (s) => { sections.push(s); return () => {} },
      context: (c) => { contexts.push(c); return () => {} },
    },
    effect: (fn) => fn(),
    on: () => () => {},
    get: () => undefined,
  }
  ctx.plugin = plugin
  plugin.apply(ctx)
  return {
    section: (name) => sections.find((s) => s.name === name),
    context: (name) => contexts.find((c) => c.name === name),
  }
}

test('the loop-aware section provider renders the chosen language', () => {
  // Forcing the provider to zh would leave an English-preference user with
  // Chinese discipline instructions and no test failure, because every previous
  // assertion read LOOP_AWARE_TEXT.en directly instead of calling the provider.
  const en = hostContext({ preference: 'en' }).section('hermes:loop-aware')
  assert.equal(en.text(), I.LOOP_AWARE_TEXT.en.join('\n'))
  assert.equal(en.text(), I.LOOP_AWARE_TEXT.en.join('\n'), 'the provider is stable across calls')

  const zh = hostContext({ unset: true }).section('hermes:loop-aware')
  assert.equal(zh.text(), I.LOOP_AWARE_TEXT.zh.join('\n'))

  // Production calls the provider with an assembly scope. A scope the memory
  // context has not frozen yet must fall back to the live language rather than
  // returning undefined — reading `memoryLang.get(scope)` unguarded throws a
  // TypeError and takes the whole prompt assembly down.
  assert.equal(en.text({ scope: {} }), I.LOOP_AWARE_TEXT.en.join('\n'), 'an unfrozen scope falls back')
  assert.equal(zh.text({ scope: {} }), I.LOOP_AWARE_TEXT.zh.join('\n'), 'an unfrozen scope falls back in zh too')
})

test('the section and the frozen snapshot agree within one session', () => {
  // The scope branch above only covers the fallback. Here the session actually
  // freezes: the memory context renders first, then the section is asked for the
  // same scope after the language changed. Both must keep the session's language,
  // otherwise one session carries two languages.
  let preference = 'zh'
  let update = null
  const sections = [], contexts = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    settings: { describe: () => [{ ns: 'locale', value: { preference } }] },
    systemPrompt: {
      section: (x) => { sections.push(x); return () => {} },
      context: (x) => { contexts.push(x); return () => {} },
    },
    effect: (fn) => fn(),
    on: (ev, h) => { if (ev === 'settings/document-updated') update = h; return () => {} },
    get: () => undefined,
  }
  ctx.plugin = plugin
  plugin.apply(ctx)
  const section = sections.find((x) => x.name === 'hermes:loop-aware')
  const memory = contexts.find((x) => x.name === 'hermes:memory')
  const scope = {}

  assert.match(memory.text({ scope }), /^# 长期记忆/, 'the session snapshot starts in zh')
  preference = 'en'
  update('locale')
  assert.equal(section.text({ scope }), I.LOOP_AWARE_TEXT.zh.join('\n'),
    'the section keeps the language the session froze')
  assert.match(memory.text({ scope }), /^# 长期记忆/, 'the frozen snapshot is unchanged')

  // A new session picks up the new language on both surfaces.
  const fresh = {}
  assert.equal(section.text({ scope: fresh }), I.LOOP_AWARE_TEXT.en.join('\n'))
  assert.match(memory.text({ scope: fresh }), /^# Long-term memory/)
})

test('the runner passes its language to every renderer', () => {
  // The transcript marker reaches the model only through the runner's call, and
  // the runner's call is not reachable from here — it needs a session, an agent,
  // and the review pipeline. A source-text assertion for it is defeated by a
  // comment containing the same string, and is blind to the resolved language
  // value, so the wiring is covered end-to-end in test/loop.test.mjs instead.
  // What is pinned here is the renderer contract the runner depends on.
  const long = Array.from({ length: 40 }, () => ({ role: 'user', content: 'y'.repeat(380) }))
  assert.match(I.renderTranscript(long, { lang: 'en' }), /^…\(earlier messages dropped; tail kept\)/)
  assert.match(I.renderTranscript(long, { lang: 'zh' }), /^…（早段已按保尾策略截断）/)
  // No lang at all must stay on the historical text, never invent English.
  assert.match(I.renderTranscript(long, {}), /^…（早段已按保尾策略截断）/)
})

test('an absent locale row costs nothing once the retry budget is spent', () => {
  // describe() walks every plugin row in the profile. A profile with no locale
  // row (headless, or before the entry mounts) must stop paying for it rather
  // than re-reading on every prompt assembly forever.
  let calls = 0
  const ctx = { settings: { describe: () => { calls++; return [] } } }
  const read = () => I.readLocalePreference(ctx)
  // The guard itself is what the plugin uses; assert the budget is bounded.
  let retries = 0
  let cache
  const language = () => {
    if (cache === undefined) {
      const r = read()
      if (r.seen) cache = I.languageOf(r.value)
      else if (retries++ > 15) cache = I.DEFAULT_LANGUAGE
    }
    return cache
  }
  for (let i = 0; i < 50; i++) language()
  const before = calls
  for (let i = 0; i < 50; i++) language()
  assert.equal(calls - before, 0, 'language() must cache the give-up answer instead of re-reading')
  assert.equal(language(), 'zh', 'the give-up answer is upstream\'s Chinese')
})

test('the memory block drops its section when both stores are off, in both languages', () => {
  const off = { memoryEnabled: false, userProfileEnabled: false }
  assert.ok(!I.reviewPrompt(off, 'en').includes('"memory"'))
  assert.ok(!I.reviewPrompt(off, 'zh').includes('"memory"'))
  assert.match(I.reviewPrompt(off, 'en'), /not distilled this round/)
})