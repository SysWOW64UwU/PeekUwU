const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// Confirms a packaged artifact contains exactly what was built and already
// verified.
//
// This deliberately asserts *equality with dist/*, never a hardcoded expectation
// of its own. An earlier version re-asserted the Chrome permission list inline
// here and silently went stale when activeTab and scripting were added for the
// live theme probe — the build was correct, the duplicate check was not. The one
// place that knows what a valid manifest looks like is verify-build.js; this
// step only proves the packaging did not alter what that script approved.

const [zipPath, distDir, prefix] = process.argv.slice(2);

if (!zipPath || !distDir || !prefix) {
    console.error("usage: node scripts/verify-zip.js <zip> <dist-dir> <prefix-inside-zip>");
    process.exit(1);
}

function fail(message) {
    console.error(`\n::error::${message}\n`);
    process.exit(1);
}

function run(command, args) {
    try {
        return execFileSync(command, args, { maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
        fail(`${command} failed while reading ${zipPath}: ${error.message}`);
    }
}

// List entries. unzip knows zip archives best; bsdtar is the portable fallback
// and is what runs on Windows.
function listEntries() {
    try {
        return execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" });
    } catch {
        return execFileSync("tar", ["-tf", zipPath], { encoding: "utf8" });
    }
}

// Read one entry as raw bytes so content can be compared exactly.
function readEntry(entry) {
    try {
        return execFileSync("unzip", ["-p", zipPath, entry], { maxBuffer: 64 * 1024 * 1024 });
    } catch {
        return execFileSync("tar", ["-xOf", zipPath, entry], { maxBuffer: 64 * 1024 * 1024 });
    }
}

function walk(dir, base = dir, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, base, acc);
        else acc.push(path.relative(base, full).split(path.sep).join("/"));
    }
    return acc.sort();
}

const zipEntries = listEntries()
    .split("\n")
    .map((line) => line.trim().replace(/\\/g, "/"))
    .filter(Boolean)
    .filter((entry) => !entry.endsWith("/"));

if (zipEntries.length === 0) {
    fail(`${zipPath} contains no files`);
}

const misplaced = zipEntries.filter((entry) => !entry.startsWith(`${prefix}/`));
if (misplaced.length) {
    fail(
        `archive entries are not under the "${prefix}/" folder. Users unzip this and Chrome loads ` +
            `that exact folder, so its name must be preserved.\n` +
            misplaced.map((e) => `    ${e}`).join("\n")
    );
}

const relEntries = zipEntries.map((entry) => entry.slice(prefix.length + 1)).sort();
const distFiles = walk(distDir);

// Identify the variant before comparing content. A wrong-variant repack also
// fails the byte comparison, but "you packaged Firefox" is the message that
// tells the developer what to do, so it must not be shadowed by "files differ".
const manifest = JSON.parse(readEntry(`${prefix}/manifest.json`).toString("utf8"));
if (manifest.browser_specific_settings) {
    fail(`the archive holds the FIREFOX variant (it has browser_specific_settings), not Chrome`);
}
if ("update_url" in manifest) {
    fail("a Chrome manifest must not carry update_url");
}
if (manifest.host_permissions) {
    fail("a Chrome manifest must not request host_permissions");
}
const builtManifest = JSON.parse(fs.readFileSync(path.join(distDir, "manifest.json"), "utf8"));
if (manifest.version !== builtManifest.version) {
    fail(
        `the archive is version ${manifest.version} but the build is ${builtManifest.version}. ` +
            `The zip is stale - rebuild before packaging.`
    );
}

const missing = distFiles.filter((rel) => !relEntries.includes(rel));
if (missing.length) {
    fail(
        `${zipPath} is missing ${missing.length} file(s) that the build produced:\n` +
            missing.map((m) => `    ${m}`).join("\n")
    );
}

const extra = relEntries.filter((rel) => !distFiles.includes(rel));
if (extra.length) {
    fail(
        `${zipPath} contains ${extra.length} file(s) that were never built:\n` +
            extra.map((e) => `    ${e}`).join("\n")
    );
}

const changed = [];
for (const rel of distFiles) {
    const inZip = readEntry(`${prefix}/${rel}`);
    const built = fs.readFileSync(path.join(distDir, rel));
    if (!inZip.equals(built)) changed.push(rel);
}
if (changed.length) {
    fail(
        `${changed.length} file(s) differ between ${zipPath} and ${distDir}. The archive is stale ` +
            `or was repacked.\n` + changed.map((c) => `    ${c}`).join("\n")
    );
}

// The manifest is checked for variant identity above, before the byte comparison
// so that a wrong-variant repack is reported as such.
console.log(
    `zip verified - ${zipEntries.length} files match ${distDir} exactly ` +
        `(version ${manifest.version}, permissions ${JSON.stringify(manifest.permissions)})`
);