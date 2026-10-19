const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "shared", "popup.js"), "utf8");

const errors = [];
const listeners = [];
const mqListeners = [];

const elements = {};

let pageScheme = "light";
let popupScheme = "light";

function makeEl(id) {
    return {
        id,
        checked: false,
        textContent: "",
        title: "",
        classList: { toggle() {}, remove() {}, add() {} },
        setAttribute() {},
        getAttribute: () => null,
        addEventListener(evt, fn) {
            listeners.push({ id, evt, fn });
        },
        dataset: {},
    };
}

function makeMedia(query) {
    const wantsDark = query.includes("dark");
    return {
        get matches() {
            return wantsDark ? popupScheme === "dark" : true;
        },
        addEventListener(evt, fn) {
            mqListeners.push({ evt, fn });
        },
    };
}

const doc = {
    getElementById: (id) => (elements[id] ||= makeEl(id)),
    body: { dataset: {} },
    addEventListener() {},
};

const storageData = {};

const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h),
    document: doc,
    navigator: { userAgent: "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36" },
    Promise,
    Date,
    Object,
    Array,
    Set,
    Boolean,
    Number,
    String,
    Math,
    JSON,
    RegExp,
    Error,
};

sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.matchMedia = (q) => makeMedia(q);
sandbox.window.matchMedia = (q) => makeMedia(q);

let probeCount = 0;

let activeTabUrl = "https://github.com/test";
const reloadCalls = [];

sandbox.chrome = {
    storage: {
        sync: {
            get(defaults, cb) {
                cb({ ...defaults });
            },
            set() {},
        },
        local: {
            get(defaults, cb) {
                const out = {};
                for (const k of Object.keys(defaults || {})) {
                    out[k] = storageData[k] ?? defaults[k];
                }
                cb(out);
            },
            set() {},
        },
        onChanged: { addListener(fn) { listeners.push({ id: "storage", evt: "changed", fn }); } },
    },
    tabs: {
        query(q, cb) {
            cb([{ id: 7, incognito: true, url: activeTabUrl }]);
        },
        reload(id) {
            reloadCalls.push(id);
        },
        TAB_ID_NONE: -1,
    },
    scripting: {
        executeScript() {
            probeCount++;
            return Promise.resolve([{ result: { scheme: pageScheme, themeCookie: null } }]);
        },
    },
    extension: { inIncognitoContext: false },
    runtime: { lastError: null },
};

vm.createContext(sandbox);

const checks = [];
const record = (label, ok) => checks.push([label, ok]);

try {
    vm.runInContext(src, sandbox, { filename: "popup.js" });
} catch (error) {
    errors.push(`module load: ${error.message}`);
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    record("popup.js loads without throwing", errors.length === 0);
    record("registered storage.onChanged listener", listeners.some((l) => l.id === "storage"));
    record("registered matchMedia change listener", mqListeners.length > 0);

    const storageFn = listeners.find((l) => l.id === "storage" && l.evt === "changed");
    if (storageFn) {
        try {
            storageFn.fn(
                { contentScheme_incognito: { newValue: "dark" }, theme_incognito: { newValue: "dark" } },
                "local"
            );
            record("storage.onChanged handler runs without throwing", true);
        } catch (error) {
            record("storage.onChanged handler runs without throwing: " + error.message, false);
        }
    } else {
        record("storage.onChanged handler present", false);
    }

    const mqFn = mqListeners[0] && mqListeners[0].fn;
    if (mqFn) {
        try {
            mqFn({ matches: true });
            record("matchMedia change handler runs without throwing", true);
        } catch (error) {
            record("matchMedia change handler runs without throwing: " + error.message, false);
        }
    } else {
        record("matchMedia change handler present", false);
    }

    await settle(700);

    vm.runInContext('lastChangeVia = "none"', sandbox);
    const before = probeCount;
    pageScheme = "dark";
    popupScheme = "dark";
    await settle(900);
    const via = vm.runInContext("lastChangeVia", sandbox);
    const probes = probeCount - before;
    record(
        `poll notices a scheme change with no change event (probes=${probes}, via=${via})`,
        probes > 0 && via === "poll"
    );

    const quiet = probeCount;
    await settle(900);
    const idleProbes = probeCount - quiet;
    record(
        `baseline re-probes stay on a slow cadence (${idleProbes} in 900ms, want <= 2)`,
        idleProbes <= 2
    );

    vm.runInContext(
        `
        scope = "incognito";
        activeTabIsReddit = false;
        state.followRedditTheme = true;
        state.theme = "system";
        redditTheme = "system";
        relayedScheme = "dark";
        `,
        sandbox
    );
    pageScheme = "light";
    popupScheme = "dark";
    await settle(700);
    let resolved = vm.runInContext("browserScheme()", sandbox);
    record(
        `Reddit System on a non-reddit tab follows the page, not the popup's own scheme (got ${resolved}, want light)`,
        resolved === "light"
    );

    pageScheme = "dark";
    popupScheme = "dark";
    await settle(700);
    resolved = vm.runInContext("browserScheme()", sandbox);
    record(`...and keeps tracking the OS afterwards (got ${resolved}, want dark)`, resolved === "dark");

    vm.runInContext('relayedScheme = "light";', sandbox);
    resolved = vm.runInContext("browserScheme()", sandbox);
    record(`...a frozen relay still cannot override the live probe (got ${resolved}, want dark)`, resolved === "dark");

    vm.runInContext(
        `
        state.followRedditTheme = true;
        redditTheme = "dark";
        relayedScheme = "dark";
        `,
        sandbox
    );
    pageScheme = "light";
    await settle(700);
    const pinned = vm.runInContext("activeChoice()", sandbox);
    record(`a pinned Reddit theme is not overridden by a non-reddit tab (got ${pinned}, want dark)`, pinned === "dark");

    vm.runInContext("state.autoRefresh = true;", sandbox);
    vm.runInContext('scope = "regular";', sandbox);

    activeTabUrl = "https://github.com/test";
    reloadCalls.length = 0;
    vm.runInContext('saveSetting("removeAds", true)', sandbox);
    await settle(50);
    record(
        `auto-refresh leaves a non-reddit tab alone (reloads=${reloadCalls.length}, want 0)`,
        reloadCalls.length === 0
    );

    activeTabUrl = "https://www.reddit.com/r/test/";
    reloadCalls.length = 0;
    vm.runInContext('saveSetting("removeAds", false)', sandbox);
    await settle(50);
    record(
        `auto-refresh still reloads a reddit tab (reloads=${reloadCalls.length}, want 1)`,
        reloadCalls.length === 1
    );

    activeTabUrl = undefined;
    reloadCalls.length = 0;
    vm.runInContext('saveSetting("removeAds", true)', sandbox);
    await settle(50);
    record(
        `auto-refresh skips a tab with no readable url (reloads=${reloadCalls.length}, want 0)`,
        reloadCalls.length === 0
    );

    for (const [label, ok] of checks) {
        console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}`);
    }
    const bad = checks.filter(([, ok]) => !ok).length;
    console.log(bad === 0 ? "\nPASS" : `\n${bad} failed`);
    process.exit(bad === 0 ? 0 : 1);
})();