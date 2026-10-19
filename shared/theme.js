(function (root) {
    "use strict";

    const RELAY_REFRESH_MS = 2000;

    function createThemePublisher(storage) {
        const scope = storage.incognito ? "incognito" : "regular";
        const themeKey = `theme_${scope}`;
        const schemeKey = `contentScheme_${scope}`;

        const schemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

        let contextLost = false;
        let lastRead = 0;
        let lastPublishedTheme = null;
        let lastPublishedScheme = null;

        function safeStorageSet(patch) {
            if (!storage.local) {
                return false;
            }
            try {
                storage.local.set(patch);
                return true;
            } catch {
                contextLost = true;
                return false;
            }
        }

        function readRedditTheme() {
            const match = document.cookie.match(/(?:^|;\s*)theme=([^;]*)/);
            const raw = match ? match[1] : null;
            if (raw === "1") {
                return "light";
            }
            if (raw === "2") {
                return "dark";
            }
            return "system";
        }

        function publish() {
            if (contextLost) {
                return;
            }
            const theme = readRedditTheme();
            const scheme = schemeQuery.matches ? "dark" : "light";
            const patch = {};
            if (theme !== lastPublishedTheme) {
                patch[themeKey] = theme;
                lastPublishedTheme = theme;
            }
            if (scheme !== lastPublishedScheme) {
                patch[schemeKey] = scheme;
                lastPublishedScheme = scheme;
            }
            if (Object.keys(patch).length > 0) {
                safeStorageSet(patch);
            }
        }

        function sweep() {
            if (contextLost) {
                return;
            }
            const now = Date.now();
            if (now - lastRead < 1000) {
                return;
            }
            lastRead = now;
            publish();
        }

        function start() {
            schemeQuery.addEventListener("change", publish);
            setInterval(sweep, RELAY_REFRESH_MS);
        }

        return { sweep, start };
    }

    root.createThemePublisher = createThemePublisher;
})(window);