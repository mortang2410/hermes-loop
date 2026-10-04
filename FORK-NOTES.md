# Fork notes

Fork of [weibaohui/hermes-loop](https://github.com/weibaohui/hermes-loop) **v0.1.16** (MIT). No pull
request upstream. This file records what changed so a later upstream release can be re-synced by
re-applying the diff below rather than by hand-editing a diverged tree.

## What this fork adds

**Route A: the host half reads the DSH locale preference out of the shared settings document and
renders its model-facing copy in that language.**

Upstream hard-codes Chinese into three surfaces that a model actually reads:

| Surface | Upstream location | Now |
|---|---|---|
| Review prompt sent to the background review agent | `reviewPrompt()` | `REVIEW_PROMPT_TEXT[lang]` |
| Long-term-memory snapshot injected at session start | `renderMemoryContext()` | `MEMORY_CONTEXT_TEXT[lang]` |
| In-session "wrap-up distillation" prompt section | `hermes:loop-aware` | `LOOP_AWARE_TEXT[lang]` |
| Review input headings + memory block + reasoning label | inline in the review runner | `REVIEW_INPUT_TEXT[lang]`, `REVIEW_MEMORY_BLOCK_TEXT[lang]` |

**What did NOT change:** `client/bundle.js` (the browser panel already registered `zh`/`en`
dictionaries with `ctx.locale` and followed the active language on its own), every settings field,
the settings `Config` schema, all skill/memory parsing and writing, trigger logic, curator logic,
and the activity/usage ledgers.

## Why route A, and why it is not "just read a service"

dsh has **no cross-plane locale service**. `@deepseek-ai/dsh-client-locale`'s host half is three
lines of settings wiring; the only live `LocaleRuntime` is constructed inside the browser
(`client.js`, `new LocaleRuntime(ctx, ctx.configForms.get('locale'), bootstrap)`) and provided
there alone. So the host cannot call a locale service even though host and client are the same
machine — they are separate JS realms behind a process boundary.

The one durable trace is the `preference` field in the settings document, namespace `locale`,
written by the Settings → General → Language row. This fork reads that document through the same
`ctx.settings.describe()` projection the plugin already uses for its own namespace, and refreshes
on the same `settings/document-updated` event. The Language row therefore stays the single source
of truth; no second setting is introduced.

## Files changed (everything else is byte-identical to upstream)

| File | Change |
|---|---|
| `src/index.js` | `LOCALE_SETTINGS_NS`, `DEFAULT_LANGUAGE`, `readLocalePreference()`, `languageOf()`, the five `*_TEXT` dictionaries, `language()` state + watcher in `apply()`, localized `reviewPrompt` / `renderMemoryContext` / memory block / input headings / reasoning label, `hermes:loop-aware` as a provider, new `__internals` exports |
| `package.json` | renamed `@local/hermes-loop-i18n`, version `0.1.16-i18n.1`, description/keywords, `publishConfig.access: restricted` |
| `cordis.patch.yml` | plugin row points at `@local/hermes-loop-i18n` |
| `test/i18n.test.mjs` | new — see Verifying below |

Unchanged: `client/bundle.js`, `README.md`.

## Non-obvious invariants — do not "simplify" these away

1. **An unset preference means Chinese, never English.** Absence is not a neutral "no language":
   the *client* treats unset as "fall back to the browser" (`LocaleRuntime.resolveActive`), which
   the host cannot see. Rather than invent an English default the user never chose, this fork
   treats unset as upstream's Chinese. Consequence: a user whose Firefox reports English but who
   never opens Settings → Language keeps Chinese host-side copy while the GUI is English. **To get
   English, the language must be explicitly selected once** — that writes `preference` into the
   document, and from then on host and client agree.
2. **`readLocalePreference` must distinguish "unset" from "unreadable".** A `seen: false` result
   means the `locale` entry has not mounted into the settings projection yet; it must not be cached
   as zh, or a late-mounting entry is never noticed. The `language()` closure retries for ~30s,
   and the `settings/document-updated` watcher invalidates the cache on any `locale` change.
   `seen: true, value: undefined` is the genuine "readable, no explicit choice" case.
3. **Values that are not locale ids are ignored.** The preference is validated against the same
   BCP-47-ish pattern the client uses before it is trusted, so a junk value degrades to zh instead
   of becoming an arbitrary language.
4. **The zh branch is upstream's text verbatim, and a test enforces it.** `test/i18n.test.mjs`
   loads the *upstream* module, evaluates its unexported `reviewPrompt`, and asserts
   `fork.reviewPrompt(eff) === upstream.reviewPrompt(eff)` across five memory-flag combinations
   and for `renderMemoryContext`. This is what makes the fork safe for a user who never touches
   the Language row: with no preference it is a no-op. It caught one real drift during
   development (a dropped blank line at the memory-section boundary).
5. **`hermes:loop-aware` became a prompt provider, not a static string.** Its text is a *section*,
   so it sits in the request prefix; making it a provider means a language change is reflected on
   the next assembly instead of requiring a restart. The prefix-cache cost is confined to the rare
   language-change event, which is exactly when a cache miss is expected. The upstream comment
   above the registration warns that section text changes invalidate the prefix — keep that in
   mind before making this dynamic for other reasons.
6. **The language is decided once per review run** (`const lang = language()` at the top of the
   review-runner scope) and threaded into every surface of that prompt, so the protocol text, the
   memory block, and the headings cannot disagree within one review.
7. **Memory entry text is never translated.** Only the framing words ("entries", "chars",
   "USER (user profile)") are localized; the `§ …` lines are user- and review-authored content and
   pass through untouched. Translating them would mean round-tripping a language the store does not
   track.

## Verifying a change

```sh
node --check src/index.js && node --check client/bundle.js
node --test test/*.test.mjs
```

The test oracle reads the pristine upstream copy from
`~/.dsh/profiles/web/node_modules/@weibaohui/hermes-loop/src/index.js`. **If the upstream package is
upgraded or removed, that path must be repointed before the suite is meaningful** — otherwise the
equivalence assertions silently stop comparing anything real.

Runtime proof (after the bundle is installed and the language set to English):

```sh
grep -o "review copy language [a-z]*" ~/.dsh/logs/*.log | tail -1
```

Expect `review copy language en`. The next new session's context snapshot should then read
`# Long-term memory (…)` rather than `# 长期记忆（…）`.

The memory snapshot is **frozen per session**, so a language change only shows up in sessions
started after the change. The review prompt is read fresh per review, so it reacts immediately.