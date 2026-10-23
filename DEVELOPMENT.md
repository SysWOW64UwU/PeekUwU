# PeekUwU — agent reference

**This file is the operating manual for coding agents and AI assistants working on
PeekUwU.** Read it before editing. It is not a human blog post — it is a spec:
invariants, contracts, failure modes, and the exact commands to verify a change.

For what the extension does and how to install it, see [README.md](README.md).

---

## 0. Orientation

PeekUwU is a browser extension (and userscript) that removes Reddit's NSFW login
walls, blur overlays, blocking modals and ads. It is **not** on any extension store.
Releases are GitHub-only: Chrome `.zip` (unpacked), Firefox `.xpi` (AMO-signed),
and a `.user.js` userscript.

```
shared/core.js     DOM sweep — the uncensoring engine. ALL variants.
shared/theme.js    relay publisher — extensions only.
shared/popup.js    popup UI + theme resolution. Extensions only.
shared/popup.*     popup HTML/CSS.
variants/          per-target manifests, userscript header.
scripts/           verify-build.js, popup-harness.js, make-updates.js.
build.js           zero-dependency build. VERSION lives here.
dist/              build output, gitignored.
```

`core.js` + `theme.js` concatenate into the extension payload. The userscript gets
`core.js` **only**. This is a build-time exclusion, not a runtime guard.

### Commands

```sh
node build.js                    # build all three variants into dist/
node scripts/verify-build.js     # ~132 build invariants. MUST be 0 failures.
node scripts/popup-harness.js    # executes popup.js in a stubbed DOM
```

**A change is not done until `verify-build.js` reports zero failures.** Run both
after every edit. It is fast (seconds) and needs no setup.

`web-ext` is **not** a project dependency — there is no `package.json` and no
`node_modules`. Every invocation goes through `npx --yes web-ext@10`, which fetches
into a throwaway cache. Use that same pinned form locally so you test the version CI
signs with. `npx web-ext` unpinned resolves to whatever `latest` happens to be and,
on a cold cache, stops for an interactive prompt.

---

## 1. Hard invariants — never violate these

These are enforced by `verify-build.js`. Breaking one fails the build.

| # | Invariant | Why it exists |
| --- | --- | --- |
| I1 | **`shared/*.js` contains no comments.** | All reasoning lives in this file. A comment explaining *why* belongs here instead. |
| I2 | **`VERSION` in `build.js` is the only version source.** | Two sources always drift. Never add a version elsewhere. |
| I3 | **Chrome permissions are exactly `["storage","activeTab","scripting"]`.** | Adding any host permission triggers a "read all your data" warning and breaks the project's core promise. |
| I4 | **Firefox permissions are exactly `["storage","browserSettings","scripting","activeTab"]`.** | `browserSettings` is read-only usage; it triggers one unavoidable warning. |
| I5 | **No `host_permissions` in any manifest.** | See I3. |
| I6 | **`shared/core.js` must not contain any theme subsystem symbol.** | The userscript payload asserts zero theme symbols. One import breaks the userscript. |
| I7 | **Extension payload is `core.js` + `theme.js`, byte for byte.** | Byte equality is asserted; concatenation order matters. |
| I8 | **`data_collection_permissions.required` is exactly `["none"]`,** and `strict_min_version >= 140`. | AMO rejects a new add-on without it; Firefox <140 fatally errors on the key. Coupled — one cannot change without the other. |
| I14 | **`gecko_android` must exist with `strict_min_version >= 142`.** | AMO's signing endpoint reads this key to decide whether an upload is Android-compatible at all. Omit it and **every future XPI is signed desktop-only**, silently cutting Android users off from updates. The floor is 142 because Firefox for Android learned the consent key two releases after desktop. See §5.4. |
| I9 | **Gecko ID is `peekuwu@syswow64uwu.github.io` and is stable.** | A mismatch between source and built manifest silently disables Firefox auto-update. Never use a test/throwaway ID. |
| I10 | **`DEBUG_PANEL` must be `false`.** | The panel reads all of `chrome.storage` on every render. |
| I11 | **No `__VERSION__` / `__REPO_URL__` survives into `dist/`.** | Placeholders reaching users means a broken link or version string. |
| I12 | **The relay never decides the popup's scheme.** | It freezes when its publishing tab closes. See §3.4. |
| I13 | **The scheme probe is NOT gated on `reddit.com`.** | Gating it made `Reddit: System` disagree with `System` off-Reddit. See §3.3. |

---

## 2. Contracts between files

Understand these before moving anything across a boundary.

### 2.1 `core.js` ⇄ popup

`core.js` reads `storage.sync` for `{ enabled, removeAds }` and never writes them.
The popup owns writes via `persist()` → `chrome.storage.sync.set`. `core.js` reacts
through `storage.sync.onChanged`. **Do not add new synced settings without adding
them to all three of:** `SETTINGS_DEFAULTS` in `core.js`, `DEFAULTS` in `popup.js`,
and the `RELOAD_FREE_KEYS` decision.

### 2.2 `core.js` ← `theme.js`

`createUncensor(storage, createThemePublisher)` — the second argument is **optional**.
`core.js` does:

```js
const theme = createThemePublisher ? createThemePublisher(storage) : null;
if (theme) { theme.sweep(); }
if (theme) { theme.start(); }
```

The userscript passes nothing, so `theme` is `null` and every call site is a no-op.
Any new theme call site **must** be `if (theme)`-guarded.

### 2.3 Two independent cookie→theme mappers

`theme.js:readRedditTheme()` and `popup.js:themeFromCookie()` implement the same
mapping (`"1"`→light, `"2"`→dark, else system). **This duplication is unavoidable**:
an `executeScript` injected function is serialised independently and cannot close
over `theme.js` code. The verifier extracts both and asserts they agree on every
cookie value, so they cannot drift. **If you change one, change both in the same
commit** or the build fails.

### 2.4 `REDDIT_URL` is the single "is this Reddit?" oracle

`popup.js` defines `REDDIT_URL`, mirroring the content script's match pattern
(`*://*.reddit.com/*`). It answers three questions: theme trust, probe target
selection, and auto-refresh eligibility. It is **not** the same as `activeTabIsReddit`
— that is the cached boolean, `REDDIT_URL` is the predicate. The verifier extracts the
regex and tests lookalikes (`reddit.com.evil.test`, `reddit.community`) and restricted
schemes (`chrome://extensions`).

---

## 3. Theme resolution — the hard subsystem

This is where every real bug in this project has lived. Read it before touching
`popup.js`.

### 3.1 The two contexts

A popup renders in the browser's **UI context**. Pages render in the **content
context**. In an Incognito window these can disagree:

- Firefox: private chrome is forced dark via `browser.theme.dark-private-windows`
  while pages keep following the regular theme.
- Chromium: a forced-dark-pages setting does something similar.

Result: a popup can be light over dark content, or dark over light content. This is
why `activeTab` + `scripting` exist at all.

### 3.2 Source precedence

```
browserScheme():
  1. contentSchemeOverride   (Firefox browserSettings only; authoritative)
  2. matchMediaScheme()      (regular windows — popup context is truth)
  3. live probe              (incognito — trust-gated, see 3.3)
  4. matchMediaScheme()      (fallback; ALWAYS LIVE)
```

**The relay is deliberately absent.** See §3.4.

### 3.3 Trust rules — scheme vs cookie

`probeSchemeTrusted()` returns `activeChoice() === "system"`.

- **Scheme → trust any tab.** The question is *"what is the OS scheme"*, and every
  page's `prefers-color-scheme` is a fair proxy. This is what makes `Reddit: System`
  behave identically to `System` on every tab.
- **Scheme → do not trust when the choice is explicit light/dark.** The probe is not
  consulted at all; the question does not arise.
- **Cookie → trust only `activeTabIsReddit`.** Cookies are origin-scoped: probing a
  non-Reddit tab finds **no** `theme` cookie, which maps to `"system"` and would
  silently masquerade as a real answer.

> **Regression to avoid (I13).** An earlier `probeSchemeTrusted()` was:
> `if (!state.followRedditTheme && state.theme === "system") return true; return activeTabIsReddit;`
> That made `Reddit: System` disagree with `System` on non-Reddit tabs. A check now
> rejects any `return activeTabIsReddit;` inside that function.

Trust is evaluated at **read time**, not when the probe lands, so switching modes
re-evaluates against the value already in hand with no re-injection.

### 3.4 The relay is a cache, never a source

`theme.js` writes `theme_<scope>` and `contentScheme_<scope>` to
`chrome.storage.local`, scoped per context because that storage is **shared between
normal and Incognito**.

The moment the publishing Reddit tab closes, **the relay stops updating and freezes
at its last value forever.** It must therefore never be consulted ahead of a live
reading. `browserScheme()` returns `live || matchMediaScheme()` — `matchMediaScheme()`
always returns a valid scheme, so the relay is unreachable.

It still serves two real purposes: theming Reddit *pages*, and carrying a cookie
across tabs. Those are legitimate. Deciding the popup's scheme is not.

### 3.5 Probes are snapshots — re-read, and re-read twice

A probe result is a point-in-time value. Capturing it once left the popup showing a
frozen scheme until reopened, and because it outranks the fallback, **nothing else
could correct it**.

Re-read triggers: init, popup scheme change, the poll, and any relayed change.
A failed probe **clears** the values (`liveTabScheme = null; liveTabTheme = null`) so
a closed or navigated-away tab falls back rather than freezing.

**Each read happens twice**, via `refreshLiveTabContextSoon()`:
immediate, then again after `PROBE_SETTLE_MS` (400ms). The popup's `matchMedia`
flips the instant the OS theme does; the page's catches up a frame or two later. An
immediate-only read captures the pre-change value and nothing re-triggers it. This
presented as *"the popup ignores my OS theme switch."*

> **Regression to avoid.** `refreshLiveTabContextSoon()` must `return` a promise —
> three call sites chain `.then(render)` onto it. A missing `return` parses fine and
> throws `Cannot read properties of undefined (reading 'then')` at runtime.

### 3.6 The `matchMedia` change event is not trusted

In a Chrome popup that event arrives **seconds late**. Non-Reddit tabs visibly
lagged; Reddit only looked instant because its content script's storage write was
doing the real work.

`setInterval` (250ms) polls `matchMediaScheme()` and re-probes on a real change.
The event is kept as a fast path, not replaced.

### 3.7 Baseline re-probe — why divergence detection fails

A probe is a snapshot, and in Incognito the popup document and the active tab can
belong to different contexts. The page can change without the popup noticing.

Detecting this by comparing probe vs popup scheme is **circular**: a stale probe
agrees with the popup, so it reports no divergence. Discovering it requires
re-reading the page. Hence the unconditional `POPUP_PROBE_REFRESH_MS` (1000ms)
baseline tick. A popup lives for seconds; once per second is not a real cost, and it
makes a stale probe structurally impossible.

### 3.8 Incognito detection uses the tab, not the extension

`chrome.extension.inIncognitoContext` can report `"regular"` for a popup opened from
an Incognito window. `tab.incognito` is authoritative and needs no permission.

`tab.url` is readable because `activeTab` is granted by the click that opened the
popup. A restricted page leaves `url` undefined → reads as not-Reddit → skips the
live probe. **This is correct behaviour, not a bug.**

### 3.9 Auto-refresh reloads Reddit only

`reloadActiveTab()` re-reads `tab.url` from the tab being reloaded (not the cached
`activeTabIsReddit`) so it cannot act on a stale answer if focus moved. Content
scripts only run on Reddit, so reloading anything else would discard user state for
no benefit.

`RELOAD_FREE_KEYS` (`autoRefresh`, `theme`, `followRedditTheme`) never trigger a
reload — they are display-only or self-applied.

---

## 4. `core.js` sweep engine

### 4.1 Ordering matters

`uncensor()` runs in a deliberate order. When changing it, preserve the sequence:

```
theme.sweep()
if (settings.removeAds) { removeAdPosts(); }   ← its OWN toggle, runs above the early return
if (!settings.enabled) {            ← EARLY RETURN
    writeOver18Cookie(""); removeStylesheetGuard(); return;
}
installStylesheetGuard()
writeOver18Cookie("true")
XPROMO_IDS.forEach(remove)          ← xpromo overlays need explicit removal
document.body.classList.remove("rpl-scroll-lock")   ← unfreeze scroll
revealBlurredContainers()
enablePreviousNextArrowOnCarouselsMobile()
revealXpromoContainers()
promoteRevealedSlots()
removeThumbnailShadows()
unblurThumbnails()
unblurFaceplateImgs()
unblurHighlightCards()
releasePostMediaContainment()            ← strips `isolate` + `overflow-hidden`
scanForBlurGates()                   ← most expensive, runs last
```

`XPROMO_IDS` (top of `core.js`) holds Reddit's blocking overlay ids that have no
useful content to preserve, so they are deleted outright:

| id | what it is |
| --- | --- |
| `configured-xpromo-blocking_xpromo_nsfw_blocking` | Forced "Mature Content" popup on Mobile |
| `configured-xpromo-blocking_xpromo_nsfw_blocking_desktop` | Forced "Mature Content" popup on Desktop |
| `configured-xpromo-mweb3x_feeds_blocking_xpromo_lo_page_fade` | Forced "Get the Reddit App" overlay on mobile feed |

Reddit renames these without warning. When a new one appears, append the id to
`XPROMO_IDS` **and** to `XPROMO_BLOCKERS` in `scripts/verify-build.js`; the verifier
fails on a blocker that is not on the list, so the two cannot drift apart.

Ad removal has its own switch: `settings.removeAds` (`SETTINGS_DEFAULTS` in `core.js`,
default `true`). It is **independent of `enabled`** — two separate toggles, two separate
behavioural consequences — so the call sits **before** the `enabled` early-return and
still removes ads when uncensoring is off. Every other sweep step is skipped when
disabled; ad removal is the one that is not.

`writeOver18Cookie` writes Reddit's `over18` cookie. `removeStylesheetGuard()` must
pair with `installStylesheetGuard()` or the CSS override leaks while disabled.

### 4.2 Throttling

`SWEEP_MIN_INTERVAL_MS` (200) floors sweeps via `scheduleSweep()`. The page mutates
constantly while scrolling; bursts collapse into one run per frame, but a sustained
stream can no longer drive 60 full re-checks per second. `sweepQueued` prevents
stacking.

### 4.3 Shadow-root recursion — do not "optimise" this

`SHADOW_SCAN_INTERVAL_MS` (1000) rate-limits `purgeBlurGates()`, which recurses into
every shadow root. Walking all elements is the most expensive operation in a sweep.

> **NEVER add an early-exit guard** such as "is a `devvit2-blur-gate` present?"
> before descending. That produces false negatives: gates nested inside another
> shadow root are silently missed and the extension appears to work intermittently.
> This is explicitly rate-limited, not short-circuited.

### 4.4 `releasePostMediaContainment()` — remove, never rewrite

Reddit renders post media inside:

```html
<div class="relative overflow-hidden pointer-cursor isolate bg-neutral-background …"
     slot="post-media-container"></div>
```

Two classes there constrain the media, and both are stripped:

```js
document
    .querySelectorAll('shreddit-post div[slot="post-media-container"]')
    .forEach((media) => {
        media.classList.remove("isolate", "overflow-hidden");
    });
```

- **`isolate`** creates a CSS stacking context, which traps overlay and blur
  compositing inside the media box.
- **`overflow-hidden`** clips anything overflowing the box. Removing it is a
  *visual* change, not just a compositing one — media that Reddit deliberately
  crops can now render outside its frame. **If post images start bleeding into
  neighbouring content, this class is the first thing to restore.**

Constraints on the implementation:

- **Scope it to `shreddit-post`.** The `slot` attribute is generic; a bare
  `div[slot="post-media-container"]` could match unrelated markup.
- **Use `classList.remove()`, never `className =`.** That div carries a long utility
  class string (`relative overflow-hidden pointer-cursor bg-neutral-background
  xs:rounded-4 mt-xs` and more). Rewriting `className` to drop two classes destroys the
  rest and visibly breaks layout. A verifier check rejects any `className =` in
  `core.js`.
- **Do not narrow the selector with `:is(.isolate, .overflow-hidden)` for speed.**
  The engine walks every element regardless; the class filter only prunes the final
  match list. Matching the bare container is more robust — it catches containers
  carrying just one of the two classes — and costs nothing measurable.
- **`classList.remove()` is a no-op for absent classes**, so re-running the sweep on
  an already-clean container does nothing.

### 4.5 The MutationObserver has a deliberate blind spot

```js
observer.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ["style"],
});
```

`attributeFilter: ["style"]` means Reddit's theme toggle — which swaps a **class** on
`<html>` — is invisible to the observer. This is why `theme.js` has its own
`RELAY_REFRESH_MS` (2000ms) sweep. The blind spot is known and compensated for;
do not remove the interval without replacing the coverage.

### 4.6 Selectors are the fragile surface

Reddit changes markup freely. Every `querySelectorAll` in `core.js` is a potential
breakage point. When Reddit changes:

- Prefer `shreddit-*` / `faceplate-img` custom elements — they are stable API-ish.
- `installStylesheetGuard()` injects a CSS override for `thumbnail-blur`; if images
  stay blurred, check this first — Reddit may re-apply an inline filter that CSS
  cannot beat without `!important`.
- After editing selectors, run the build and manually load the unpacked extension.

---

## 5. Build and release

### 5.1 Build

`node build.js` wipes `dist/` and rebuilds all three variants. Zero dependencies;
Node 18+.

`build.js` concatenates sources and stamps `__VERSION__` / `__REPO_URL__`. The
Chrome zip must extract to a folder named `PeekUwU/` — the README tells users not to
rename it, and the release workflow enforces it.

### 5.2 Release

Run the **Release** workflow from the Actions tab after pushing:

1. Build + verify
2. Zip Chrome → `PeekUwU.zip`
3. Sign Firefox via AMO unlisted → `PeekUwU.xpi`
4. Generate `updates.json` (SHA-256 of the signed XPI)
5. Publish all four assets

**Release notes are a file, not a workflow input.** `RELEASE_NOTES.md` at the repo root
is passed straight to `gh release create --notes-file` as a literal path in the
`Publish the release` step, so the notes content never travels through an input, an
environment variable or shell interpolation — only `IS_PRERELEASE` uses `env`.
`preflight.js` fails the build if the file is missing or empty. The
`workflow_dispatch` input box is a single-line control (see §9), so notes can never
be entered there.

**Tone: write for the person who installs PeekUwU, not for the person who wrote it.**
Name the outcome, never the mechanism — no selectors, class names, function names or
DOM structure. The user reads *"removed a new kind of promoted post"*; `ad-event-tracker`
and `closest("li")` are maintainer details that mean nothing at install time. One
`- ` bullet per change.

**Bump `VERSION` before running it.** Versions cannot go backwards and AMO rejects a
version it has already signed.

`--source-dir=dist/firefox` is passed explicitly to `web-ext`. Signing the wrong
directory produces a valid-looking XPI for the wrong browser; a verifier check
catches it. Keep that check.

### 5.3 Why Firefox requires 140

Not a preference — forced by AMO. Since 2025-11-03 every new add-on must declare
`browser_specific_settings.gecko.data_collection_permissions`. That key exists only
in Firefox 140+; older versions throw a fatal manifest error. Declaring it while
claiming older support is rejected outright, so the floor must be 140.0.

Windows 7/8/8.1 (ESR 115) therefore cannot install any AMO-signed XPI — this
affects every signed add-on, not just this one. The userscript is unaffected.

### 5.4 Firefox for Android — `gecko_android` is load-bearing

One `.xpi` serves both platforms. Android support is declared by a single key:

```json
"browser_specific_settings": {
    "gecko":         { "strict_min_version": "140.0", ... },
    "gecko_android": { "strict_min_version": "142.0" }
}
```

Two facts make this non-optional:

**1. Omitting `gecko_android` silently signs every XPI desktop-only.** Since the
October 2023 AMO fix, the signing endpoint — which `web-ext sign` also uses — reads
this key to decide Android compatibility. Mozilla's own words: *"If the developer of
an add-on that was flagged for compatibility with Android does not take action, new
versions of the add-on sent to AMO will not be flagged as Android compatible. As a
result Android users will not receive the new versions."* There is no workflow flag
and no CI step that can compensate — it is manifest-only.

**2. The Android floor is higher than the desktop floor.** Firefox for Android gained
`data_collection_permissions` in **142**, two releases after desktop's 140. Setting
`gecko_android.strict_min_version` to the desktop value produces a manifest that
looks correct and installs nowhere useful. `web-ext lint` reports this as
`KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`, and the verifier enforces it.

Verified working on a physical device (Firefox for Android, `web-ext run -t
firefox-android`). Every API the popup depends on is available on Android:
`activeTab` (48), `scripting`, `tabs.query`, `storage.*`, and
`browserSettings.overrideContentColorScheme` (95). MV3 is fully supported since
Firefox 128 — the Workshop's older "use Manifest V2 for Android" advice is stale.
None of the known MV3-on-Android gaps apply, because all three concern
`host_permissions` and this extension has none (I5).

`updates.json` needs no change: it is keyed on `gecko.id`, which is shared across
platforms, so Android auto-updates from the same manifest.

**Testing on a device** requires `adb` and a device with USB debugging plus Firefox's
*Remote debugging via USB*:

```sh
node build.js
npx --yes web-ext@10 run -t firefox-android --source-dir=dist/firefox --android-device=<serial>
```

`--android-device` is mandatory — web-ext lists connected devices then **throws** if
the flag is absent, even with exactly one device attached. Run it from the repo root,
not from inside `dist/firefox`: a shell whose working directory is the build output
**pins that directory**, and the next `node build.js` fails with `EBUSY`.

**You cannot inspect the popup in DevTools on Android** (Firefox bug 1637616). Use
`adb logcat | grep peekuwu` instead.

### 5.5 Popup layout is platform-scoped, and that is deliberate

`body { width: 320px }` is the desktop popup and must stay that way. The Android
rules are all scoped under `body[data-platform="android"]`, a dataset attribute set
from `runtime.getPlatformInfo().os`. They widen the sheet, enlarge touch targets to
44px, and scale type up.

**Do not "simplify" this with a media query.** The popup document's own viewport
*is* the popup — roughly 320px on desktop — so `@media (max-width: ...)` cannot tell
the platforms apart. Platform detection has to come from JS.

On Android the about-panel starts **open**: a 320px-tall popup floating in the
middle of an ~800px phone screen looks broken, and the panel fills that space
usefully.

The knob the UI switch is `translateX(16px)` on `.toggle-knob`, driven by
`input:checked + .toggle-track`. Any Android override must target that exact
selector — there is no `.is-on` class.

---

## 6. Testing discipline

### 6.1 `verify-build.js`

Static invariants over built output. Run after every change; expect zero failures.

It also enforces **I1** (no comments in `shared/*.js`). If you need to explain
something in code, put the explanation here.

### 6.2 `popup-harness.js` — why syntax checks are insufficient

`node --check` validates **syntax only**. A function that parses perfectly but returns
nothing instead of a promise passes `--check` and then throws in the browser console.
Both the missing-`return` bug (§3.5) and a temporal-dead-zone bug shipped past
`--check` in this project.

The harness **executes** `popup.js` in a stubbed DOM: it loads the real file, fires
`storage.onChanged` and `matchMedia` handlers, drives simulated OS theme changes, and
asserts resolved values.

**It models the page's scheme and the popup document's scheme as separate values**,
because in Incognito they genuinely diverge. A harness assuming they always match
would pass while the real bug was live.

### 6.3 Every check must be proven to fail

**A check that has never failed has not been shown to work.** When adding a check:

```sh
# 1. inject the exact bug the check is meant to catch
# 2. run node scripts/verify-build.js  → expect FAIL
# 3. restore the file
# 4. re-run → expect pass
```

Do this for every new harness assertion. It is the only way to know the check is not
vacuously true.

### 6.4 Manual verification

`verify-build.js` and the harness cannot simulate OS theme changes in a real popup.
Before calling theme work done, manually confirm in Incognito:

1. `Reddit: System` on a **non-Reddit** tab, OS light → popup shows **light**
2. Flip OS to dark → popup follows **live**
3. Close the Reddit tab, then repeat → must **still** track live
4. `Reddit` pinned dark, active tab non-Reddit → must **stay dark**
5. Toggle *Remove ads* on a non-Reddit tab → **no reload**

Case 4 is the one that catches an over-broad fix: the scheme probe may be trusted
anywhere, but the **cookie** must not be.

---

## 7. Style

- 4-space indent, double quotes, semicolons.
- `const` by default; `let` only when reassigned.
- No dependencies. Adding one changes the project's entire premise.
- No comments in `shared/*.js` (I1). Explain in this file.
- No `console.log` in shipped code — `popup.js` has a debug panel for diagnostics.
- Prefer optional chaining and `?.` for DOM access; Reddit's DOM is frequently null.
- Guard `storage.local` access — it throws in some Incognito states
  (`theme.js:safeStorageSet`).

---

## 8. Common tasks

| Task | Where | Verify with |
| --- | --- | --- |
| Reddit changed its markup | `shared/core.js` selectors | build + manual load |
| Popup shows a stale/wrong theme | `shared/popup.js` §3 | harness + manual Incognito |
| New popup toggle | `popup.js` `DEFAULTS`, `popup.html`, `RELOAD_FREE_KEYS` | verifier |
| New synced setting | `core.js` `SETTINGS_DEFAULTS` **and** `popup.js` `DEFAULTS` | verifier |
| Release | `build.js` `VERSION`, then Release workflow | `verify-build.js` |
| Selector needs an early exit | — | **Don't. See §4.3.** |

---

## 9. Traps

- **`storage.local` is shared between normal and Incognito.** All theme keys must be
  suffixed `_<scope>`. Un-suffixed keys leak settings across contexts.
- **`executeScript` functions cannot close over module scope.** The cookie mapper is
  duplicated because of this (§2.3).
- **`tab.url` is `undefined` on restricted pages.** Treat as not-Reddit; do not throw.
- **The scheme never falls back to the relay**, even when the relay holds a value.
  §3.4 explains why: it freezes the moment its publishing tab closes.
- **`releases/latest/download` skips prereleases.** A prerelease never displaces the
  last stable for existing users.
- **AMO `update_url` is read once at install time.** Changing it later does not reach
  existing installs; they must reinstall.
- **`releases` and the about panel use `https://github.com/SysWOW64UwU/PeekUwU`.**
  The profile link is `https://github.com/SysWOW64UwU/`. Verifier checks all four.
- **`workflow_dispatch` has no multiline input.** GitHub renders a `type: string`
  input as a single-line `<input>`, so newlines cannot be typed, Enter submits the
  workflow, and a pasted block is flattened to one line by the browser before the
  runner ever sees it. Release notes therefore live in `RELEASE_NOTES.md` at the repo
  root, passed with `--notes-file`. `preflight.js` requires the file to exist and be
  non-empty so a blank release cannot be published.

---

## 10. Definition of done

- [ ] `node build.js` succeeds
- [ ] `node scripts/verify-build.js` → **0 failures**
- [ ] `node scripts/popup-harness.js` → **PASS**
- [ ] New checks were proven to fail when the bug is injected
- [ ] Manual Incognito checks pass if theme logic changed (§6.4)
- [ ] No comments added to `shared/*.js`; any needed rationale is in **this file**
- [ ] `VERSION` bumped if this is a release