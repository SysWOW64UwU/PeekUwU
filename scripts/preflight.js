const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// Everything `node build.js` and `node scripts/verify-build.js` read. Checked
// before either runs so a partial upload fails with a readable list instead of a
// module-resolution stack trace.
const REQUIRED = [
    "build.js",
    "scripts/verify-build.js",
    "scripts/verify-zip.js",
    "scripts/popup-harness.js",
    "scripts/make-updates.js",
    "shared/core.js",
    "shared/theme.js",
    "shared/popup.js",
    "shared/popup.html",
    "shared/popup.css",
    "shared/icons/ExtensionLogo.svg",
    "shared/icons/icon16.png",
    "shared/icons/icon32.png",
    "shared/icons/icon48.png",
    "shared/icons/icon128.png",
    "variants/chrome/manifest.json",
    "variants/firefox/manifest.json",
    "variants/userscript/header.txt",
    "RELEASE_NOTES.md",
];

const missing = REQUIRED.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));

if (missing.length) {
    console.error(`\n::error::Incomplete checkout - ${missing.length} required file(s) missing\n`);
    for (const rel of missing) {
        console.error(`    ${rel}`);
    }
    console.error("\nUpload the complete project before running this workflow.");
    console.error("Nothing was built, signed or published.\n");
    process.exit(1);
}

console.log(`preflight ok - all ${REQUIRED.length} required files present`);

// An empty notes file publishes a release with a blank description, which reads
// as a mistake. Catch it here rather than after signing.
const notes = fs.readFileSync(path.join(ROOT, "RELEASE_NOTES.md"), "utf8").trim();
if (!notes) {
    console.error("\n::error::RELEASE_NOTES.md is empty.");
    console.error("Add the release notes as one '- ' bullet per line, then run again.\n");
    process.exit(1);
}
console.log(`release notes ok - ${notes.split("\n").filter((l) => l.trim()).length} line(s)`);