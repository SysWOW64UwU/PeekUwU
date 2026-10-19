const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const { VERSION, REPO_URL } = require(path.join(ROOT, "build.js"));

function arg(flag, fallback) {
    const index = process.argv.indexOf(flag);
    if (index === -1) return fallback;
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
}

const xpiArg = arg("--xpi", null);
if (!xpiArg) {
    throw new Error("usage: node scripts/make-updates.js --xpi <signed.xpi> [--out <updates.json>] [--repo <url>]");
}

const xpiPath = path.resolve(xpiArg);
const outPath = path.resolve(arg("--out", path.join(ROOT, "artifacts", "updates.json")));
const repoUrl = arg("--repo", REPO_URL).replace(/\/+$/, "");
const firefoxManifestPath = path.join(ROOT, "dist", "firefox", "manifest.json");

if (!fs.existsSync(xpiPath)) {
    throw new Error(`signed xpi not found: ${xpiPath}`);
}
if (!fs.existsSync(firefoxManifestPath)) {
    throw new Error(`firefox build not found: ${firefoxManifestPath} (run node build.js first)`);
}

const firefoxManifest = JSON.parse(fs.readFileSync(firefoxManifestPath, "utf8"));
const gecko = (firefoxManifest.browser_specific_settings || {}).gecko || {};

if (!gecko.id) {
    throw new Error("firefox manifest has no browser_specific_settings.gecko.id");
}
if (firefoxManifest.version !== VERSION) {
    throw new Error(`version mismatch: manifest is ${firefoxManifest.version}, build.js is ${VERSION}`);
}

const hash = crypto.createHash("sha256").update(fs.readFileSync(xpiPath)).digest("hex");
const tag = `v${VERSION}`;

const updates = {
    addons: {
        [gecko.id]: {
            updates: [
                {
                    version: VERSION,
                    update_link: `${repoUrl}/releases/download/${tag}/PeekUwU.xpi`,
                    update_hash: `sha256:${hash}`,
                },
            ],
        },
    },
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(updates, null, 4) + "\n");

console.log(`wrote ${path.relative(ROOT, outPath)}`);
console.log(`  addon id   ${gecko.id}`);
console.log(`  version    ${VERSION}`);
console.log(`  update     ${updates.addons[gecko.id].updates[0].update_link}`);
console.log(`  sha256     ${hash}`);