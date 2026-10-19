const fs = require("fs");
const path = require("path");

const VERSION = "1.0.0";
const REPO_URL = "https://github.com/SysWOW64UwU/PeekUwU";
const ROOT = __dirname;
const DIST = path.join(ROOT, "dist");

function read(relPath) {
    return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

function writeDist(relPath, content) {
    const target = path.join(DIST, relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

function copyToDist(fromRel, toRel) {
    const target = path.join(DIST, toRel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(ROOT, fromRel), target, { recursive: true });
}

function buildExtension(name) {
    const manifest = JSON.parse(read(`variants/${name}/manifest.json`));
    manifest.version = VERSION;
    writeDist(`${name}/manifest.json`, JSON.stringify(manifest, null, 4) + "\n");

    copyToDist("shared/icons", `${name}/src/icon`);
    const popupHtml = read("shared/popup.html")
        .replaceAll("__VERSION__", VERSION)
        .replaceAll("__REPO_URL__", REPO_URL);
    writeDist(`${name}/src/popup/popup.html`, popupHtml);
    copyToDist("shared/popup.css", `${name}/src/popup/popup.css`);
    copyToDist("shared/popup.js", `${name}/src/popup/popup.js`);

    const bootstrap = `
window.createUncensor({
    sync: {
        get(defaults, callback) {
            chrome.storage.sync.get(defaults, callback);
        },
        onChanged: chrome.storage.onChanged,
    },
    local: chrome.storage.local,
    incognito: chrome.extension.inIncognitoContext,
}, window.createThemePublisher).init();
`;
    writeDist(`${name}/src/js/uncensor.js`, read("shared/core.js") + read("shared/theme.js") + bootstrap);
    console.log(`built dist/${name}`);
}

function buildUserscript() {
    const header = read("variants/userscript/header.txt").replace("__VERSION__", VERSION);
    const core = read("shared/core.js");
    const bootstrap = `
window.createUncensor({
    sync: {
        get(defaults, callback) {
            callback(defaults);
        },
        onChanged: { addListener() {} },
    },
}).init();
`;
    writeDist("peekuwu.user.js", header.trimEnd() + "\n" + core + bootstrap);
    console.log("built dist/peekuwu.user.js");
}

function build() {
    fs.rmSync(DIST, { recursive: true, force: true });
    buildExtension("chrome");
    buildExtension("firefox");
    buildUserscript();
}

module.exports = { VERSION, REPO_URL, DIST, build };

if (require.main === module) {
    build();
}
