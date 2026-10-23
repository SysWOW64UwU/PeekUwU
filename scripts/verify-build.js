const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const { VERSION, REPO_URL } = require(path.join(ROOT, "build.js"));

let failures = 0;
let passes = 0;

function ok(label) {
    passes++;
    console.log(`  ok    ${label}`);
}

function fail(label, detail) {
    failures++;
    console.log(`  FAIL  ${label}`);
    if (detail) console.log(`        ${detail}`);
}

function check(label, condition, detail) {
    condition ? ok(label) : fail(label, detail);
    return Boolean(condition);
}

function readDist(relPath) {
    return fs.readFileSync(path.join(DIST, relPath), "utf8");
}

function readDistJson(relPath) {
    return JSON.parse(readDist(relPath));
}

function walk(dir, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, acc);
        else acc.push(full);
    }
    return acc;
}

function parseUserscriptMeta(source) {
    const block = source.split("\n").filter((line) => line.trim().startsWith("//"));
    const meta = {};
    let inside = false;
    for (const line of block) {
        const text = line.replace(/^\/\/\s?/, "").trim();
        if (text === "==UserScript==") {
            inside = true;
            continue;
        }
        if (text === "==/UserScript==") break;
        if (!inside) continue;
        const match = text.match(/^@(\S+)\s*(.*)$/);
        if (match) meta[match[1]] = match[2].trim();
    }
    return meta;
}

const EXPECTED_USERSCRIPT_TAGS = ["name", "version", "description", "author", "match", "run-at", "grant", "updateURL", "downloadURL"];

const FIREFOX_MIN_VERSION = 140;
const DATA_CONSENT_MIN_VERSION = 140;
// Firefox for Android gained data_collection_permissions two releases after
// desktop, so its floor is higher. AMO's signing endpoint reads gecko_android to
// decide whether an upload is Android-compatible at all: omit the key and every
// future XPI is signed desktop-only, silently cutting Android users off from
// updates. web-ext lint reports KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION
// if this floor is ever set below the Android release that understands the key.
const FIREFOX_ANDROID_MIN_VERSION = 142;
const ANDROID_DATA_CONSENT_MIN_VERSION = 142;
const REQUIRE_DATA_CONSENT = process.env.PEEKUWU_OMIT_DATA_CONSENT !== "1";
const sharedPopupJs = fs.readFileSync(path.join(ROOT, "shared", "popup.js"), "utf8");

console.log(`PeekUwU build verification (v${VERSION})\n`);

console.log("build output exists");
check("dist/chrome exists", fs.existsSync(path.join(DIST, "chrome")));
check("dist/firefox exists", fs.existsSync(path.join(DIST, "firefox")));
check("dist/peekuwu.user.js exists", fs.existsSync(path.join(DIST, "peekuwu.user.js")));

console.log("\nplaceholder stamping");
const leaked = [];
for (const file of walk(DIST)) {
    const text = fs.readFileSync(file, "utf8");
    if (text.includes("__VERSION__") || text.includes("__REPO_URL__")) {
        leaked.push(path.relative(DIST, file));
    }
}
check("no unreplaced __VERSION__ or __REPO_URL__ in dist", leaked.length === 0, leaked.join(", "));
check("repo url was stamped", readDist("chrome/src/popup/popup.html").includes(REPO_URL));

console.log("\nchrome manifest");
const chrome = readDistJson("chrome/manifest.json");
check("version stamped", chrome.version === VERSION, `got ${chrome.version}`);
check("manifest_version is 3", chrome.manifest_version === 3, `got ${chrome.manifest_version}`);
check("uses action (MV3)", typeof chrome.action === "object" && chrome.action !== null);
check("no browser_action (MV2 key)", chrome.browser_action === undefined);
check("permissions are storage, activeTab, scripting", JSON.stringify(chrome.permissions) === '["storage","activeTab","scripting"]', JSON.stringify(chrome.permissions));
check("no host_permissions", !chrome.host_permissions);
check("no update_url (unpacked installs never auto-update)", !("update_url" in chrome));
check("no gecko settings (not the firefox variant)", !chrome.browser_specific_settings);

console.log("\nfirefox manifest");
const firefox = readDistJson("firefox/manifest.json");
const gecko = (firefox.browser_specific_settings || {}).gecko || {};
const geckoAndroid = (firefox.browser_specific_settings || {}).gecko_android || null;
check("version stamped", firefox.version === VERSION, `got ${firefox.version}`);
check("manifest_version is 3", firefox.manifest_version === 3, `got ${firefox.manifest_version}`);
check("uses action (MV3)", typeof firefox.action === "object" && firefox.action !== null);
check("no browser_action (MV2 key)", firefox.browser_action === undefined);
check("gecko id present", typeof gecko.id === "string" && gecko.id.length > 0);
check("strict_min_version present", typeof gecko.strict_min_version === "string");
check(
    `strict_min_version is at least ${FIREFOX_MIN_VERSION}`,
    parseFloat(gecko.strict_min_version) >= FIREFOX_MIN_VERSION,
    gecko.strict_min_version
);
check(
    "gecko update_url present (enables automatic updates)",
    gecko.update_url === `${REPO_URL}/releases/latest/download/updates.json`,
    gecko.update_url
);
check(
    "update_url is https",
    typeof gecko.update_url === "string" && gecko.update_url.startsWith("https://"),
    gecko.update_url
);
check(
    "firefox permissions intact",
    JSON.stringify(firefox.permissions) === '["storage","browserSettings","scripting","activeTab"]',
    JSON.stringify(firefox.permissions)
);

console.log("\nfirefox for android");
check(
    "gecko_android is declared (without it AMO signs every XPI desktop-only)",
    geckoAndroid !== null && typeof geckoAndroid === "object",
    "add browser_specific_settings.gecko_android to variants/firefox/manifest.json"
);
check(
    "gecko_android declares a strict_min_version",
    Boolean(geckoAndroid && typeof geckoAndroid.strict_min_version === "string"),
    JSON.stringify(geckoAndroid)
);
check(
    `gecko_android strict_min_version is at least ${FIREFOX_ANDROID_MIN_VERSION}`,
    Boolean(geckoAndroid) && parseFloat(geckoAndroid.strict_min_version) >= FIREFOX_ANDROID_MIN_VERSION,
    geckoAndroid ? geckoAndroid.strict_min_version : "no gecko_android"
);
check(
    "gecko_android never trails the desktop floor",
    Boolean(geckoAndroid) &&
        parseFloat(geckoAndroid.strict_min_version) >= parseFloat(gecko.strict_min_version),
    `android ${geckoAndroid && geckoAndroid.strict_min_version} vs desktop ${gecko.strict_min_version}`
);
check(
    "both variants declare activeTab and scripting (so the live probe can run in either)",
    ["activeTab", "scripting"].every((p) => chrome.permissions.includes(p) && firefox.permissions.includes(p)),
    `chrome ${JSON.stringify(chrome.permissions)} firefox ${JSON.stringify(firefox.permissions)}`
);
check(
    "chrome declares no host permissions or browserSettings",
    !chrome.host_permissions && !chrome.permissions.includes("browserSettings")
);
check(
    "popup defers to the page by context, not by browser",
    /function shouldDeferToPage\(\)\s*\{\s*return scope === "incognito";\s*\}/.test(sharedPopupJs),
    (sharedPopupJs.match(/function shouldDeferToPage\(\)[\s\S]{0,80}/) || ["not found"])[0]
);
check(
    "the deferral rule is not gated on IS_FIREFOX",
    !/function shouldDeferToPage\(\)[\s\S]{0,160}IS_FIREFOX/.test(sharedPopupJs)
);
check(
    "regular windows still read matchMedia only",
    /if \(!shouldDeferToPage\(\)\) \{\s*return matchMediaScheme\(\);/.test(sharedPopupJs)
);

console.log("\nadd-on identity (a mismatch here silently disables Firefox auto-update)");
const sourceManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "variants", "firefox", "manifest.json"), "utf8"));
const sourceGecko = (sourceManifest.browser_specific_settings || {}).gecko || {};
const sourceGeckoAndroid = (sourceManifest.browser_specific_settings || {}).gecko_android || null;
check(
    "built gecko id matches variants/firefox/manifest.json",
    gecko.id === sourceGecko.id,
    `built ${gecko.id} vs source ${sourceGecko.id}`
);
check(
    "built gecko_android survives the build",
    Boolean(geckoAndroid) &&
        Boolean(sourceGeckoAndroid) &&
        geckoAndroid.strict_min_version === sourceGeckoAndroid.strict_min_version,
    `built ${geckoAndroid && geckoAndroid.strict_min_version} vs source ${sourceGeckoAndroid && sourceGeckoAndroid.strict_min_version}`
);
check(
    "gecko id is not a throwaway test id",
    !/test|example\.com|throwaway|gibberish/i.test(gecko.id),
    gecko.id
);

console.log(`\ndata collection consent (required by AMO since 2025-11-03)`);
if (!REQUIRE_DATA_CONSENT) {
    console.log("  SKIP  PEEKUWU_OMIT_DATA_CONSENT=1 is set — assertions skipped");
    console.log("        Note: confirmed 2026-10-14 that AMO rejects uploads without this key.");
    if (gecko.data_collection_permissions !== undefined) {
        fail("escape hatch actually omits the key", "still present in the built manifest");
    } else {
        ok("escape hatch actually omits the key");
    }
} else {
    const collection = gecko.data_collection_permissions;
    check("data_collection_permissions present", collection !== undefined && typeof collection === "object");
    check(
        'required is exactly ["none"]',
        Array.isArray(collection?.required) && collection.required.length === 1 && collection.required[0] === "none",
        JSON.stringify(collection?.required)
    );
    check(
        "no optional collection declared",
        collection?.optional === undefined || (Array.isArray(collection.optional) && collection.optional.length === 0),
        JSON.stringify(collection?.optional)
    );
    check(
        "data consent is nested under gecko, not at manifest root",
        firefox.data_collection_permissions === undefined
    );
    check(
        `strict_min_version is at least ${DATA_CONSENT_MIN_VERSION} while the consent key is present`,
        parseFloat(gecko.strict_min_version) >= DATA_CONSENT_MIN_VERSION,
        `${gecko.strict_min_version} — AMO rejects this combination, and Firefox < 140 errors on the key`
    );
    check(
        `gecko_android strict_min_version is at least ${ANDROID_DATA_CONSENT_MIN_VERSION} while the consent key is present`,
        Boolean(geckoAndroid) &&
            parseFloat(geckoAndroid.strict_min_version) >= ANDROID_DATA_CONSENT_MIN_VERSION,
        `${geckoAndroid && geckoAndroid.strict_min_version} — Firefox for Android understood the consent key two releases later than desktop, so a desktop floor here makes the extension uninstallable on Android`
    );
}

console.log("\nuserscript");
const userscript = readDist("peekuwu.user.js");
const meta = parseUserscriptMeta(userscript);
for (const tag of EXPECTED_USERSCRIPT_TAGS) {
    check(`@${tag} present`, Object.hasOwn(meta, tag));
}
check("@version stamped", meta.version === VERSION, `got ${meta.version}`);
check("@grant none", meta.grant === "none", meta.grant);
check(
    "@updateURL points at the latest release asset",
    meta.updateURL === `${REPO_URL}/releases/latest/download/peekuwu.user.js`,
    meta.updateURL
);
check(
    "@downloadURL points at the latest release asset",
    meta.downloadURL === `${REPO_URL}/releases/latest/download/peekuwu.user.js`,
    meta.downloadURL
);

console.log("\npopup");
const popupHtml = readDist("chrome/src/popup/popup.html");
const popupCss = readDist("chrome/src/popup/popup.css");
check("popup html matches firefox popup html", readDist("firefox/src/popup/popup.html") === popupHtml);
check("footer shows the version", /<span class="footer-version">v/.test(popupHtml));
check("removed toggle is gone", !popupHtml.includes("toggle-autoupdate"));
check("removed toggle css is gone", !/\.mini-track|\.mini-knob|\.footer-update|\.footer-label/.test(popupCss));
check("footer spreads source link left, version right", /\.panel-footer \{[^}]*justify-content: space-between/.test(popupCss));
check(
    "footer source link points at the repo",
    /<a class="footer-source" href="[^"]*PeekUwU"[^>]*>Source Code<\/a>/.test(popupHtml),
    (popupHtml.match(/<a class="footer-source"[^<]*<\/a>/) || ["not found"])[0]
);
check("footer source link is styled", /\.footer-source \{/.test(popupCss));

console.log("\nrelease hygiene");
const sharedPopupHtml = fs.readFileSync(path.join(ROOT, "shared", "popup.html"), "utf8");
const sharedPopupCss = fs.readFileSync(path.join(ROOT, "shared", "popup.css"), "utf8");
check(
    "DEBUG_PANEL is off (it reads all of chrome.storage on every render)",
    /const DEBUG_PANEL = false;/.test(sharedPopupJs),
    /const DEBUG_PANEL = true;/.test(sharedPopupJs) ? "set to true — revert before committing" : "not found"
);
check(
    "debug panel markup ships hidden, so it cannot flash before the script runs",
    /<div class="panel-debug" id="panel-debug" hidden>/.test(sharedPopupHtml),
    (sharedPopupHtml.match(/<div class="panel-debug"[^>]*>/) || ["not found"])[0]
);
check(
    "popup.js drives panel visibility from DEBUG_PANEL alone",
    /debugEl\.hidden = !DEBUG_PANEL;/.test(sharedPopupJs),
    "the hidden attribute is not synced from the flag, so toggling DEBUG_PANEL would not show the panel"
);

check(
    "popup.html ships a viewport meta tag (android renders without it at a default width)",
    /<meta name="viewport" content="width=device-width, initial-scale=1"/.test(sharedPopupHtml),
    "missing viewport meta - the android popup will render tiny"
);
check(
    "desktop popup width is still 320px",
    /body \{\s*width: 320px;/.test(sharedPopupCss),
    (sharedPopupCss.match(/body \{[\s\S]{0,80}/) || ["not found"])[0]
);
check(
    "android popup overrides are scoped to the platform dataset, never bare",
    /body\[data-platform="android"\] \{[\s\S]{0,200}width: 100%;/.test(sharedPopupCss),
    "expected body[data-platform=\"android\"] to widen the popup"
);
check(
    "the desktop width rule is not weakened for every platform",
    !/^body \{[^}]*width: 100%/m.test(sharedPopupCss),
    "body { width: 100% } would change the desktop popup"
);
check(
    "the android toggle knob override targets the real checked selector",
    /body\[data-platform="android"\] input:checked \+ \.toggle-track \.toggle-knob/.test(sharedPopupCss),
    "expected the same `input:checked + .toggle-track .toggle-knob` selector the base styles use"
);
check(
    "popup.js detects the platform via runtime.getPlatformInfo",
    /chrome\.runtime\.getPlatformInfo/.test(sharedPopupJs) &&
        /document\.body\.dataset\.platform = info\.os;/.test(sharedPopupJs),
    "expected document.body.dataset.platform to be set from info.os"
);
check(
    "the about panel opens by default only on android",
    /if \(info\.os === "android"\) \{\s*setAboutOpen\(true\);/.test(sharedPopupJs) &&
        /function setAboutOpen\(open\)/.test(sharedPopupJs),
    "expected the android branch to call setAboutOpen(true) via the shared helper"
);
check(
    "the about toggle reuses setAboutOpen instead of duplicating the panel state",
    /aboutToggle\.addEventListener\("click", \(\) => \{\s*setAboutOpen\(aboutPanel\.hidden\);/.test(sharedPopupJs),
    "duplicating the open/close logic lets the two paths drift apart"
);

console.log("\nabout panel links");
const AUTHOR_PROFILE_URL = "https://github.com/SysWOW64UwU/";
check(
    "github link points at the author profile, not the repo",
    new RegExp(`<a href="${AUTHOR_PROFILE_URL}"[^>]*>GitHub</a>`).test(popupHtml),
    (popupHtml.match(/<a href="[^"]*"[^>]*>GitHub<\/a>/) || ["not found"])[0]
);
check(
    "releases link points at the repo releases",
    new RegExp(`<a href="${REPO_URL}/releases"[^>]*>Releases</a>`).test(popupHtml),
    (popupHtml.match(/<a href="[^"]*"[^>]*>Releases<\/a>/) || ["not found"])[0]
);
check("telegram link is untouched", popupHtml.includes("https://t.me/C3R741NLY_1MPR3551V3"));
check(
    "repo url is still stamped and used twice",
    (popupHtml.match(new RegExp(REPO_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length === 2,
    `${(popupHtml.match(new RegExp(REPO_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length} occurrences`
);

console.log("\ncross-manifest compatibility");
const popupJs = readDist("chrome/src/popup/popup.js");
check("popup uses the MV3 scripting API", /chrome\.scripting[\s\S]{0,200}executeScript/.test(popupJs));
check(
    "popup has no leftover MV2 tabs.executeScript branch",
    !/chrome\.tabs\s*&&\s*chrome\.tabs\.executeScript/.test(popupJs)
);
check(
    "the live probe is gated on having the scripting API, not on the browser",
    /function canProbeLive\(\)[\s\S]{0,160}chrome\.scripting/.test(sharedPopupJs) &&
        !/function canProbeLive\(\)[\s\S]{0,160}IS_FIREFOX/.test(sharedPopupJs)
);
check(
    "the live probe is not gated on incognito (it must run in regular windows too)",
    !/function canProbeLive\(\)[\s\S]{0,200}shouldDeferToPage/.test(sharedPopupJs),
    "gating the probe on shouldDeferToPage leaves regular windows on a stale relayed theme"
);
check(
    "the scheme deferral is still incognito-only",
    /function shouldDeferToPage\(\)\s*\{\s*return scope === "incognito";\s*\}/.test(sharedPopupJs)
);

check(
    "the live context is refreshed rather than captured once",
    /function refreshLiveTabContext\(\)[\s\S]{0,400}readActiveTabContext\(activeTabId\)/.test(sharedPopupJs)
);
check(
    "a failed probe clears the live values instead of leaving them stale",
    /else \{\s*liveTabScheme = null;\s*liveTabTheme = null;/.test(sharedPopupJs)
);
const refreshSites = (sharedPopupJs.match(/refreshLiveTabContextSoon\(\)\.then\(render\)/g) || []).length;
check(
    "refreshed on init, on scheme change, on a relayed change, and by the scheme poll",
    refreshSites === 4,
    `found ${refreshSites} call sites, expected 4`
);
check(
    "the scheme never consults the relay ahead of a live reading",
    !/return live \|\| relayedScheme \|\|/.test(sharedPopupJs) &&
        /return live \|\| matchMediaScheme\(\);/.test(sharedPopupJs),
    "a relay is written by a reddit tab and freezes when that tab closes; it must not outrank matchMedia()"
);
check(
    "a poll bounds the popup scheme delay when the matchMedia event is late",
    /const POPUP_SCHEME_POLL_MS = \d+;/.test(sharedPopupJs) &&
        /setInterval\(\(\) => \{[\s\S]{0,400}matchMediaScheme\(\)[\s\S]{0,400}refreshLiveTabContextSoon\(\)/.test(sharedPopupJs),
    "expected a setInterval that compares matchMediaScheme() and re-probes on a real change"
);
check(
    "the settling probe probes immediately and again after a delay",
    /const PROBE_SETTLE_MS = \d+;/.test(sharedPopupJs) &&
        /function refreshLiveTabContextSoon\(\)[\s\S]{0,400}refreshLiveTabContext\(\)\.then\(render\)/.test(sharedPopupJs) &&
        /probeTimer = setTimeout\([\s\S]{0,200}PROBE_SETTLE_MS/.test(sharedPopupJs)
);
const soonBody = /function refreshLiveTabContextSoon\(\)\s*\{([\s\S]*?)\n\}/.exec(sharedPopupJs);
check(
    "the settling probe does not call itself",
    Boolean(soonBody) && !soonBody[1].includes("refreshLiveTabContextSoon"),
    soonBody ? soonBody[1].trim() : "function not found"
);
check(
    "a repeating settle probe clears its previous timer",
    /if \(probeTimer !== null\) \{\s*clearTimeout\(probeTimer\);/.test(sharedPopupJs)
);
check(
    "the settling probe returns a promise (call sites chain .then onto it)",
    /function refreshLiveTabContextSoon\(\)[\s\S]{0,400}\n    return \w+;\n\}/.test(sharedPopupJs),
    (sharedPopupJs.match(/function refreshLiveTabContextSoon\(\)[\s\S]{0,400}/) || ["not found"])[0]
);

console.log("\npopup runtime");
const harness = require("child_process").spawnSync(process.execPath, [path.join(__dirname, "popup-harness.js")], {
    encoding: "utf8",
    timeout: 20000,
});
const harnessOut = (harness.stdout || "") + (harness.stderr || "");
for (const line of harnessOut.split("\n").filter((l) => l.includes("ok  ") || l.includes("FAIL"))) {
    check(line.replace(/^\s*(ok|FAIL)\s+/, "runtime: ").trim(), !line.includes("FAIL"), line.trim());
}
if (harness.error) {
    fail("popup runtime harness ran", harness.error.message);
}
check(
    "browserScheme gates the probed value on probeSchemeTrusted()",
    /const live = probeSchemeTrusted\(\) \? liveTabScheme : null;/.test(sharedPopupJs) &&
        !/return liveTabScheme \|\| relayedScheme/.test(sharedPopupJs),
    "the probe can still sit permanently on top of a fresher relayed value"
);
check(
    "probeSchemeTrusted trusts the live probe on any tab while the theme resolves to system",
    /function probeSchemeTrusted\(\)\s*\{\s*return activeChoice\(\) === "system";\s*\}/.test(sharedPopupJs),
    (sharedPopupJs.match(/function probeSchemeTrusted\(\)[\s\S]{0,160}/) || ["not found"])[0]
);
check(
    "auto-refresh only ever reloads a reddit tab",
    /function reloadActiveTab\(\)[\s\S]{0,1200}!REDDIT_URL\.test\(tab\.url\)[\s\S]{0,200}chrome\.tabs\.reload\(tab\.id\)/.test(
        sharedPopupJs
    ),
    (sharedPopupJs.match(/function reloadActiveTab\(\)[\s\S]{0,600}/) || ["not found"])[0]
);
check(
    "the scheme probe is not gated on reddit.com",
    !/return activeTabIsReddit;/.test(sharedPopupJs),
    "a gate here made \"Reddit: System\" disagree with \"System\" on non-reddit tabs"
);
check(
    "the probed scheme has a baseline refresh so a snapshot cannot sit stale",
    /const POPUP_PROBE_REFRESH_MS = \d+;/.test(sharedPopupJs) &&
        /lastProbeRefreshAt[\s\S]{0,200}refreshLiveTabContextSoon\(\)\.then\(render\)/.test(sharedPopupJs),
    "without a baseline tick a page that changes without the popup noticing keeps a stale probe"
);
check(
    "the debug source label honours the same trust gate",
    /function browserSchemeSource\(\)[\s\S]{0,400}probeSchemeTrusted\(\) \? liveTabScheme : null/.test(sharedPopupJs),
    "the panel would report a source that is being ignored"
);
check(
    "reddit theme from the probe is trusted only on reddit.com",
    /const live = activeTabIsReddit \? liveTabTheme : null;/.test(sharedPopupJs)
);
const redditRe = /const REDDIT_URL = (\/\^.*\/i);/.exec(sharedPopupJs);
check("reddit url pattern is declared", Boolean(redditRe));
if (redditRe) {
    const re = eval(redditRe[1]);
    const accepted = [
        "https://www.reddit.com/",
        "https://old.reddit.com/r/aww",
        "http://reddit.com",
        "https://np.reddit.com/r/all",
        "https://www.reddit.com?x=1",
    ];
    const rejected = [
        "https://reddit.com.evil.test/",
        "https://notreddit.com/",
        "https://www.google.com/",
        "https://reddit.community/",
        "chrome://extensions",
    ];
    const missed = accepted.filter((u) => !re.test(u));
    const leaked = rejected.filter((u) => re.test(u));
    check(
        "it matches reddit urls the content script also matches",
        missed.length === 0,
        missed.join(", ")
    );
    check("it does not match lookalike or restricted urls", leaked.length === 0, leaked.join(", "));
}
check(
    "tab url is captured at init for the reddit check",
    /activeTabIsReddit = Boolean\(tab && tab\.url && REDDIT_URL\.test\(tab\.url\)\);/.test(sharedPopupJs)
);

console.log("\npayload");
const sharedCore = fs.readFileSync(path.join(ROOT, "shared", "core.js"), "utf8");
const sharedTheme = fs.readFileSync(path.join(ROOT, "shared", "theme.js"), "utf8");
const chromePayload = readDist("chrome/src/js/uncensor.js");
const firefoxPayload = readDist("firefox/src/js/uncensor.js");
const userscriptPayload = readDist("peekuwu.user.js");

check(
    "shared core shipped identically to both variants",
    chromePayload.startsWith(sharedCore) && firefoxPayload.startsWith(sharedCore)
);
check(
    "extension payloads are core + theme, byte for byte",
    chromePayload.startsWith(sharedCore + sharedTheme) &&
        firefoxPayload.startsWith(sharedCore + sharedTheme)
);
check(
    "both variants get the same payload",
    chromePayload === firefoxPayload
);
check("userscript payload is core alone", userscriptPayload.includes(sharedCore));

console.log("\nsource carries no comments");
const commentedFiles = ["core.js", "theme.js", "popup.js"]
    .map((name) => {
        const lines = fs.readFileSync(path.join(ROOT, "shared", name), "utf8").split("\n");
        return { name, count: lines.filter((l) => /^\s*(\/\/|\/\*|\*)/.test(l)).length };
    })
    .filter((f) => f.count > 0);
check(
    "the shipped JS carries no comments (rationale lives in the README)",
    commentedFiles.length === 0,
    commentedFiles.map((f) => `${f.name} (${f.count})`).join(", ")
);

console.log("\ntheme publishing is extension-only");
const THEME_SYMBOLS = [
    "root.createThemePublisher = createThemePublisher",
    "readRedditTheme",
    "schemeKey",
    "themeKey",
    "lastPublishedTheme",
    "safeStorageSet",
];
check("theme.js is a standalone source file", sharedTheme.length > 0 && sharedTheme.includes("createThemePublisher(storage)"));
check("core.js no longer defines the theme subsystem", THEME_SYMBOLS.every((s) => !sharedCore.includes(s)));
check("core.js removed the contextLost cross-dependency", !sharedCore.includes("contextLost"));
check("theme.js owns its own contextLost", sharedTheme.includes("contextLost"));
check(
    "theme relay refreshes periodically (cookie changes fire no DOM mutation)",
    /setInterval\(sweep,\s*RELAY_REFRESH_MS\)/.test(sharedTheme) && /const RELAY_REFRESH_MS = \d+;/.test(sharedTheme),
    "no periodic sweep - the relayed theme will go stale"
);
check(
    "the relay refresh interval is longer than the sweep throttle",
    (() => {
        const relay = Number((sharedTheme.match(/RELAY_REFRESH_MS = (\d+);/) || [])[1]);
        const throttle = Number((sharedTheme.match(/lastRead < (\d+)/) || [])[1]);
        return Number.isFinite(relay) && Number.isFinite(throttle) && relay > throttle;
    })(),
    "a refresh faster than the throttle would just re-read and discard"
);

function extractMapper(source, name) {
    try {
        const start = source.indexOf(`function ${name}(`);
        if (start === -1) return null;
        const open = source.indexOf("{", start);
        if (open === -1) return null;
        let depth = 0;
        let end = -1;
        for (let i = open; i < source.length; i++) {
            if (source[i] === "{") depth++;
            else if (source[i] === "}") {
                depth--;
                if (depth === 0) {
                    end = i;
                    break;
                }
            }
        }
        if (end === -1) return null;
        const text = source.slice(start, end + 1);
        const factory = new Function("document", `return (${text});`);
        return (raw) => factory({ cookie: `theme=${raw}` })(raw);
    } catch {
        return null;
    }
}
const relayMapper = extractMapper(sharedTheme, "readRedditTheme");
const probeMapper = extractMapper(sharedPopupJs, "themeFromCookie");
check("both theme mappers were found and parsed", Boolean(relayMapper && probeMapper));
if (relayMapper && probeMapper) {
    const mismatched = ["1", "2", "3", "", null, "dark", "0", "system"]
        .map((raw) => {
            try {
                return { raw, relay: relayMapper(raw), probe: probeMapper(raw) };
            } catch (error) {
                return { raw, relay: `threw ${error.message}`, probe: "—" };
            }
        })
        .filter((r) => r.relay !== r.probe);
    check(
        "live probe and relay agree on every theme cookie value",
        mismatched.length === 0,
        mismatched.map((m) => `${JSON.stringify(m.raw)}: relay=${m.relay} probe=${m.probe}`).join("; ")
    );
}
check(
    "popup prefers the live theme over the relayed one",
    /const live = activeTabIsReddit \? liveTabTheme : null;\s*return live \|\| redditTheme \|\| "system";/.test(
        sharedPopupJs
    ),
    (sharedPopupJs.match(/function effectiveRedditTheme\(\)[\s\S]{0,140}/) || ["not found"])[0]
);
check(
    "the probe reads Reddit's theme cookie from the active tab",
    /func: \(\) => \(\{[\s\S]{0,200}themeCookie: document\.cookie\.match/.test(sharedPopupJs)
);
check(
    "core.js takes the theme factory as an optional second argument",
    /function createUncensor\(storage, createThemePublisher\)/.test(sharedCore)
);
check(
    "core.js guards both theme call sites",
    /if \(theme\) \{\s*theme\.sweep\(\);/.test(sharedCore) && /if \(theme\) \{\s*theme\.start\(\);/.test(sharedCore)
);

const themeLeak = THEME_SYMBOLS.filter((s) => userscriptPayload.includes(s));
check("userscript ships no theme code at all", themeLeak.length === 0, themeLeak.join(", "));

for (const [name, payload] of [["chrome", chromePayload], ["firefox", firefoxPayload]]) {
    const missing = THEME_SYMBOLS.filter((s) => !payload.includes(s));
    check(`${name} payload still carries the full theme publisher`, missing.length === 0, missing.join(", "));
    check(`${name} bootstrap passes the theme factory`, payload.includes("}, window.createThemePublisher).init();"));
}
check("userscript bootstrap passes no theme factory", !userscriptPayload.includes("window.createThemePublisher)"));

check(
    "post media containers drop isolate and overflow-hidden inside shreddit-post only",
    /function releasePostMediaContainment\(\)[\s\S]{0,400}shreddit-post div\[slot="post-media-container"\][\s\S]{0,400}classList\.remove\("isolate", "overflow-hidden"\)/.test(
        sharedCore
    ) &&
        /releasePostMediaContainment\(\);/.test(sharedCore),
    "expected releasePostMediaContainment() to strip `isolate` and `overflow-hidden` from the post-media container and be called from uncensor()"
);
check(
    "isolate is removed from the class list, not by rewriting className",
    !/className\s*=/.test(sharedCore),
    "rewriting className would drop the other utility classes Reddit puts on that div"
);

const XPROMO_BLOCKERS = [
    "configured-xpromo-blocking_xpromo_nsfw_blocking",
    "configured-xpromo-blocking_xpromo_nsfw_blocking_desktop",
    "configured-xpromo-mweb3x_feeds_blocking_xpromo_lo_page_fade",
];
const missingXpromo = XPROMO_BLOCKERS.filter((id) => !sharedCore.includes(`"${id}"`));
check(
    "every known xpromo blocking container is on the removal list",
    missingXpromo.length === 0,
    `not removed by uncensor(): ${missingXpromo.join(", ")}`
);
check(
    "xpromo ids are removed by id, not re-queried as selectors",
    /XPROMO_IDS\.forEach\(\(id\) => document\.getElementById\(id\)\?\.remove\(\)\)/.test(sharedCore),
    "expected XPROMO_IDS.forEach with getElementById(...).remove()"
);

const AD_SELECTORS = ["shreddit-ad-post", "shreddit-comments-page-ad", "ad-event-tracker"];
const adBody =
    sharedCore.split("function removeAdPosts(")[1]?.split("function writeOver18Cookie(")[0] || "";
const missingAds = AD_SELECTORS.filter((selector) => !adBody.includes(`"${selector}"`));
check(
    "removeAdPosts() drops every known ad element",
    missingAds.length === 0,
    `not removed by removeAdPosts(): ${missingAds.join(", ")}`
);
const adsGate = sharedCore.indexOf("if (settings.removeAds)");
const enabledEarly = sharedCore.indexOf("if (!settings.enabled)");
check(
    "ad removal is gated by its own removeAds switch, above the enabled early return",
    adsGate > -1 &&
        enabledEarly > -1 &&
        adsGate < enabledEarly &&
        /if \(settings\.removeAds\) \{\s*removeAdPosts\(\);\s*\}/.test(sharedCore),
    "expected if (settings.removeAds) { removeAdPosts(); } placed before if (!settings.enabled)"
);

function finish() {
    const total = passes + failures;
    console.log(`\n${passes}/${total} checks passed`);
    if (failures > 0) {
        console.error(`${failures} check(s) failed`);
        process.exit(1);
    }
}

if (failures === 0 && process.argv[2]) {
    verifySignedXpi(process.argv[2]);
}

finish();

function readZipEntry(zipPath, entry) {
    const attempts = [
        ["unzip", ["-p", zipPath, entry]],
        ["tar", ["-xOf", zipPath, entry]],
    ];
    let lastError;
    for (const [command, args] of attempts) {
        try {
            return execFileSync(command, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError;
}

function verifySignedXpi(xpiPath) {
    console.log("\nsigned xpi (must be the firefox variant)");
    const resolved = path.resolve(xpiPath);
    let raw;
    try {
        raw = readZipEntry(resolved, "manifest.json");
    } catch (error) {
        fail("xpi is readable", `${resolved}: ${error.message}`);
        return;
    }
    const signed = JSON.parse(raw);
    const signedGecko = (signed.browser_specific_settings || {}).gecko || {};
    const signedGeckoAndroid = (signed.browser_specific_settings || {}).gecko_android || null;
    check("xpi manifest version stamped", signed.version === VERSION, `got ${signed.version}`);
    check("xpi manifest_version is 3", signed.manifest_version === 3, `got ${signed.manifest_version}`);
    check("xpi has action", typeof signed.action === "object" && signed.action !== null);
    check("xpi has gecko id", signedGecko.id === gecko.id, signedGecko.id);
    check(
        "xpi gecko id matches the manifest make-updates.js will key on",
        typeof signedGecko.id === "string" && signedGecko.id === sourceGecko.id,
        `xpi ${signedGecko.id} vs source ${sourceGecko.id}`
    );
    check("xpi carries update_url", signedGecko.update_url === gecko.update_url, signedGecko.update_url);
    check(
        "xpi carries gecko_android (a signed XPI without it is desktop-only on AMO)",
        Boolean(signedGeckoAndroid) &&
            Boolean(geckoAndroid) &&
            signedGeckoAndroid.strict_min_version === geckoAndroid.strict_min_version,
        `xpi ${signedGeckoAndroid && signedGeckoAndroid.strict_min_version} vs built ${geckoAndroid && geckoAndroid.strict_min_version}`
    );
    if (REQUIRE_DATA_CONSENT) {
        check(
            "xpi declares no data collection",
            JSON.stringify(signedGecko.data_collection_permissions?.required) === '["none"]',
            JSON.stringify(signedGecko.data_collection_permissions)
        );
    }
    check(
        "xpi permissions intact",
        JSON.stringify(signed.permissions) === '["storage","browserSettings","scripting","activeTab"]',
        JSON.stringify(signed.permissions)
    );
}