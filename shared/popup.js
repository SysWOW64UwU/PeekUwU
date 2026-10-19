const DEFAULTS = { enabled: true, removeAds: true, autoRefresh: true, followRedditTheme: true, theme: "system" };
const THEME_ORDER = ["system", "light", "dark"];
const THEME_LABEL = { system: "System", light: "Light", dark: "Dark" };
const RELOAD_FREE_KEYS = new Set(["autoRefresh", "theme", "followRedditTheme"]);

const DEBUG_PANEL = false;

const enabledToggle = document.getElementById("toggle-enabled");
const adsToggle = document.getElementById("toggle-ads");
const autoRefreshToggle = document.getElementById("toggle-autorefresh");
const followToggle = document.getElementById("toggle-follow-theme");
const themeButton = document.getElementById("theme-toggle");
const aboutToggle = document.getElementById("about-toggle");
const aboutPanel = document.getElementById("about-panel");
const followHint = document.getElementById("follow-theme-hint");
const debugEl = document.getElementById("panel-debug");

if (debugEl) {
    debugEl.hidden = !DEBUG_PANEL;
}

const schemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
const IS_FIREFOX = navigator.userAgent.includes("Firefox");

let contentSchemeOverride = null;
let relayedScheme = null;

let liveTabScheme = null;
let liveTabTheme = null;

let activeTabId = null;
let activeTabIsReddit = false;

const REDDIT_URL = /^https?:\/\/([^/]*\.)?reddit\.com(\/|$|\?|#)/i;

function shouldDeferToPage() {
    return scope === "incognito";
}

function canProbeLive() {
    return typeof chrome !== "undefined" && Boolean(chrome.scripting);
}

function themeFromCookie(raw) {
    if (raw === "1") {
        return "light";
    }
    if (raw === "2") {
        return "dark";
    }
    return "system";
}

function readActiveTabContext(tabId) {
    if (!canProbeLive()) {
        return Promise.resolve(null);
    }
    const api = typeof chrome !== "undefined" && chrome.scripting ? chrome.scripting : null;
    if (!api || tabId === undefined || tabId === chrome.tabs.TAB_ID_NONE) {
        return Promise.resolve(null);
    }
    return api
        .executeScript({
            target: { tabId },
            func: () => ({
                scheme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
                themeCookie: document.cookie.match(/(?:^|;\s*)theme=([^;]*)/)?.[1] ?? null,
            }),
        })
        .then((results) => (results && results[0] ? results[0].result : null), () => null);
}

let lastProbeAt = 0;
let probeTimer = null;

let lastChangeVia = "none";
let lastChangeAt = 0;

function refreshLiveTabContext() {
    if (!canProbeLive()) {
        return Promise.resolve();
    }
    return readActiveTabContext(activeTabId).then((value) => {
        lastProbeAt = Date.now();
        if (value) {
            liveTabScheme = value.scheme;
            liveTabTheme = themeFromCookie(value.themeCookie);
        } else {
            liveTabScheme = null;
            liveTabTheme = null;
        }
    });
}

const PROBE_SETTLE_MS = 400;

function refreshLiveTabContextSoon() {
    const immediate = refreshLiveTabContext().then(render);
    if (probeTimer !== null) {
        clearTimeout(probeTimer);
    }
    probeTimer = setTimeout(() => {
        probeTimer = null;
        refreshLiveTabContext().then(render);
    }, PROBE_SETTLE_MS);
    return immediate;
}

function probeSchemeTrusted() {
    return activeChoice() === "system";
}

function readContentSchemeOverride() {
    const ns = typeof browser !== "undefined" ? browser : typeof chrome !== "undefined" ? chrome : null;
    const api = ns && ns.browserSettings ? ns.browserSettings : null;
    if (!api || !api.overrideContentColorScheme) {
        return Promise.resolve(null);
    }
    return api.overrideContentColorScheme.get({}).then(
        (setting) => setting && setting.value,
        () => null
    );
}

function matchMediaScheme() {
    return schemeQuery.matches ? "dark" : "light";
}

function browserScheme() {
    if (contentSchemeOverride === "dark" || contentSchemeOverride === "light") {
        return contentSchemeOverride;
    }
    if (!shouldDeferToPage()) {
        return matchMediaScheme();
    }
    const live = probeSchemeTrusted() ? liveTabScheme : null;
    return live || matchMediaScheme();
}

let state = { ...DEFAULTS };
let scope = null;
let themeKey = null;
let schemeKey = null;
let redditTheme = "system";

function effectiveRedditTheme() {
    const live = activeTabIsReddit ? liveTabTheme : null;
    return live || redditTheme || "system";
}

function activeChoice() {
    return state.followRedditTheme ? effectiveRedditTheme() : state.theme;
}

function nextTheme(theme) {
    return THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
}

function choiceLabel(choice) {
    if (choice !== "system") {
        return THEME_LABEL[choice];
    }
    return `System (${THEME_LABEL[browserScheme()]})`;
}

function render() {
    enabledToggle.checked = state.enabled;
    adsToggle.checked = state.removeAds;
    autoRefreshToggle.checked = state.autoRefresh;
    followToggle.checked = state.followRedditTheme;

    const choice = activeChoice();
    document.body.dataset.theme = choice === "system" ? browserScheme() : choice;
    document.body.dataset.themeChoice = choice;
    document.body.dataset.follow = String(state.followRedditTheme);

    themeButton.classList.toggle("is-disabled", state.followRedditTheme);
    themeButton.setAttribute("aria-disabled", String(state.followRedditTheme));
    themeButton.title = state.followRedditTheme
        ? `Following Reddit theme — ${choiceLabel(choice)}`
        : `Change to ${THEME_LABEL[nextTheme(state.theme)]}`;

    followHint.textContent = state.followRedditTheme
        ? `Following Reddit: ${choiceLabel(choice)}`
        : `Currently: ${choiceLabel(choice)}`;

    refreshDebug();
}

function browserSchemeSource() {
    if (contentSchemeOverride === "dark" || contentSchemeOverride === "light") {
        return `browserSettings override (${contentSchemeOverride})`;
    }
    const live = probeSchemeTrusted() ? liveTabScheme : null;
    if (live) {
        return "active tab (live)";
    }
    return "own matchMedia (live)";
}

function refreshDebug() {
    if (!DEBUG_PANEL || !debugEl) {
        return;
    }
    if (!scope) {
        debugEl.textContent = "resolving context…";
        return;
    }
    chrome.storage.local.get(null, (all) => {
        const keys = Object.keys(all).filter(
            (k) => k.startsWith("theme_") || k.startsWith("contentScheme_")
        );
        const shown = keys.length
            ? keys.map((k) => `${k}=${all[k]}`).join("  ")
            : "none — no reddit tab has published yet";
        const source = browserSchemeSource();
        debugEl.textContent = [
            `context: ${scope}  (tab.incognito=${isIncognitoTab}, popup=${chrome.extension.inIncognitoContext})`,
            `browser: ${IS_FIREFOX ? "firefox" : "chromium"}  scheme: ${browserScheme()}  [${source}]`,
            `matchMedia says: ${matchMediaScheme()}   override=${contentSchemeOverride ?? "—"}   tab=${liveTabScheme ?? "—"}   relay(cache only)=${relayedScheme ?? "—"}`,
            `probed: ${lastProbeAt ? new Date(lastProbeAt).toLocaleTimeString() : "never"}   ${probeTimer !== null ? "settle-pending" : "settled"}   redditTab=${activeTabIsReddit}`,
            `change via: ${lastChangeVia}${lastChangeAt ? " @ " + new Date(lastChangeAt).toLocaleTimeString() : ""}`,
            `theme: live=${liveTabTheme ?? "—"}   relayed=${redditTheme}   following=${effectiveRedditTheme()}`,
            `stored: ${shown}`,
        ].join("\n");
    });
}

function persist(changes) {
    Object.assign(state, changes);
    chrome.storage.sync.set(changes);
    render();
}

function reloadActiveTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab || tab.id === undefined || !tab.url || !REDDIT_URL.test(tab.url)) {
            return;
        }
        chrome.tabs.reload(tab.id);
    });
}

function saveSetting(key, value) {
    persist({ [key]: value });
    if (!RELOAD_FREE_KEYS.has(key) && state.autoRefresh) {
        reloadActiveTab();
    }
}

function cycleTheme() {
    persist({ theme: nextTheme(state.theme) });
}

function absorbThemeState(stored) {
    redditTheme = stored[themeKey] || "system";
    relayedScheme = stored[schemeKey] || null;
    render();
}

function loadThemeState() {
    chrome.storage.local.get(
        { [themeKey]: "system", [schemeKey]: null },
        absorbThemeState
    );
}

let isIncognitoTab = null;

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    isIncognitoTab = Boolean(tab && tab.incognito);
    scope = isIncognitoTab || chrome.extension.inIncognitoContext ? "incognito" : "regular";
    themeKey = `theme_${scope}`;
    schemeKey = `contentScheme_${scope}`;
    activeTabId = tab ? tab.id : null;
    activeTabIsReddit = Boolean(tab && tab.url && REDDIT_URL.test(tab.url));
    loadThemeState();
    readContentSchemeOverride().then((value) => {
        contentSchemeOverride = value;
        render();
    });
    refreshLiveTabContextSoon().then(render);
    chrome.storage.sync.get(DEFAULTS, (stored) => {
        state = stored;
        render();
    });
    render();
});

enabledToggle.addEventListener("change", () => saveSetting("enabled", enabledToggle.checked));
adsToggle.addEventListener("change", () => saveSetting("removeAds", adsToggle.checked));
autoRefreshToggle.addEventListener("change", () => saveSetting("autoRefresh", autoRefreshToggle.checked));
followToggle.addEventListener("change", () => saveSetting("followRedditTheme", followToggle.checked));
themeButton.addEventListener("click", cycleTheme);

function setAboutOpen(open) {
    aboutPanel.hidden = !open;
    aboutToggle.classList.toggle("is-active", open);
    aboutToggle.setAttribute("aria-expanded", String(open));
}

aboutToggle.addEventListener("click", () => {
    setAboutOpen(aboutPanel.hidden);
});

function detectPlatform() {
    const api =
        typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getPlatformInfo
            ? chrome.runtime
            : null;
    if (!api) {
        return Promise.resolve(null);
    }
    return new Promise((resolve) => {
        try {
            const result = api.getPlatformInfo();
            if (result && typeof result.then === "function") {
                result.then((info) => resolve(info || null), () => resolve(null));
                return;
            }
            api.getPlatformInfo((info) => resolve(info || null), () => resolve(null));
        } catch {
            resolve(null);
        }
    });
}

detectPlatform().then((info) => {
    if (!info || !info.os) {
        return;
    }
    document.body.dataset.platform = info.os;
    if (info.os === "android") {
        setAboutOpen(true);
    }
});

schemeQuery.addEventListener("change", () => {
    lastChangeVia = "event";
    lastChangeAt = Date.now();
    readContentSchemeOverride().then((value) => {
        contentSchemeOverride = value;
        render();
        refreshLiveTabContextSoon().then(render);
    });
});

const POPUP_SCHEME_POLL_MS = 250;
const POPUP_PROBE_REFRESH_MS = 1000;
let lastSeenPopupScheme = matchMediaScheme();
let lastProbeRefreshAt = 0;

setInterval(() => {
    const now = matchMediaScheme();
    const schemeChanged = now !== lastSeenPopupScheme;
    const dueForRefresh = Date.now() - lastProbeRefreshAt >= POPUP_PROBE_REFRESH_MS;

    if (!schemeChanged && !dueForRefresh) {
        return;
    }
    lastSeenPopupScheme = now;
    lastProbeRefreshAt = Date.now();
    if (schemeChanged) {
        lastChangeVia = "poll";
        lastChangeAt = Date.now();
        render();
    }
    refreshLiveTabContextSoon().then(render);
}, POPUP_SCHEME_POLL_MS);

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local") {
        if (!scope) {
            return;
        }
        let touched = false;
        if (changes[themeKey]) {
            redditTheme = changes[themeKey].newValue || "system";
            touched = true;
        }
        if (changes[schemeKey]) {
            relayedScheme = changes[schemeKey].newValue || null;
            touched = true;
        }
        if (touched) {
            render();
            refreshLiveTabContextSoon().then(render);
        }
        return;
    }
    if (area !== "sync") {
        return;
    }
    for (const key of Object.keys(DEFAULTS)) {
        if (changes[key]) {
            state[key] = changes[key].newValue;
        }
    }
    render();
});