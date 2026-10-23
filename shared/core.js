(function (root) {
    "use strict";

    const XPROMO_IDS = [
        "configured-xpromo-blocking_xpromo_nsfw_blocking",
        "configured-xpromo-blocking_xpromo_nsfw_blocking_desktop",
        "configured-xpromo-mweb3x_feeds_blocking_xpromo_lo_page_fade",
    ];

    const SETTINGS_DEFAULTS = { enabled: true, removeAds: true };

    const SWEEP_MIN_INTERVAL_MS = 200;

    const SHADOW_SCAN_INTERVAL_MS = 1000;

    function createUncensor(storage, createThemePublisher) {
        const theme = createThemePublisher ? createThemePublisher(storage) : null;

        let settings = { ...SETTINGS_DEFAULTS };
        let stylesheetNode = null;
        let sweepQueued = false;
        let over18State = null;
        let lastSweep = 0;
        let lastShadowScan = 0;

        function liftRevealedSlot(container) {
            const revealed = container.querySelector('div[slot="revealed"]');
            if (revealed && container.parentElement) {
                container.parentElement.insertBefore(revealed, container);
                return true;
            }
            return false;
        }

        function revealBlurredContainers() {
            document.querySelectorAll("shreddit-blurred-container").forEach((container) => {
                if (liftRevealedSlot(container)) {
                    container.remove();
                }
            });
        }

        function enablePreviousNextArrowOnCarouselsMobile() {
            document
                .querySelectorAll("div.relative.pointer-events-none")
                .forEach((overlay) => overlay.classList.remove("pointer-events-none"));
        }

        function revealXpromoContainers() {
            document.querySelectorAll("xpromo-nsfw-blocking-container").forEach((container) => {
                const slotLifted = liftRevealedSlot(container);
                const bodies = container.querySelectorAll('div[id$="-post-rtjson-content"]');
                bodies.forEach((body) => {
                    if (container.parentElement) {
                        container.parentElement.insertBefore(body, container);
                    }
                });
                if (slotLifted || bodies.length > 0) {
                    container.remove();
                }
            });
        }

        function promoteRevealedSlots() {
            document.querySelectorAll("div.absolute.inset-0.h-full.w-full").forEach((frame) => {
                const revealed = frame.querySelector('div[slot="revealed"]');
                if (revealed && revealed !== frame.firstElementChild) {
                    frame.prepend(revealed);
                }
            });
        }

        function removeThumbnailShadows() {
            document
                .querySelectorAll('div[data-testid="post-thumbnail"] div.thumbnail-shadow')
                .forEach((shadow) => shadow.remove());
        }

        function unblurThumbnails() {
            document.querySelectorAll('div[data-testid="post-thumbnail"] img').forEach((img) => {
                if (img.style.filter || img.style.webkitFilter) {
                    img.style.removeProperty("filter");
                    img.style.removeProperty("-webkit-filter");
                }
            });
        }

        function unblurFaceplateImgs() {
            document.querySelectorAll("faceplate-img.thumbnail-blur").forEach((img) => {
                img.classList.remove("thumbnail-blur");
            });
        }

        function unblurHighlightCards() {
            document.querySelectorAll("community-highlight-card[blurred]").forEach((card) => {
                card.removeAttribute("blurred");
            });
        }

        function releasePostMediaContainment() {
            document
                .querySelectorAll('shreddit-post div[slot="post-media-container"]')
                .forEach((media) => {
                    media.classList.remove("isolate", "overflow-hidden");
                });
        }

        function installStylesheetGuard() {
            if (stylesheetNode) {
                return;
            }
            stylesheetNode = document.createElement("style");
            stylesheetNode.textContent =
                "faceplate-img.thumbnail-blur { filter: none !important; -webkit-filter: none !important; }";
            document.documentElement.appendChild(stylesheetNode);
        }

        function removeStylesheetGuard() {
            stylesheetNode?.remove();
            stylesheetNode = null;
        }

        function purgeBlurGates(scope) {
            scope.querySelectorAll("devvit2-blur-gate").forEach((gate) => gate.remove());
            scope.querySelectorAll("*").forEach((host) => {
                if (host.shadowRoot) {
                    purgeBlurGates(host.shadowRoot);
                }
            });
        }

        function removeAdPosts() {
            document.querySelectorAll("shreddit-ad-post").forEach((ad) => ad.remove());
            document.querySelectorAll("shreddit-comments-page-ad").forEach((adc) => adc.remove());
            document.querySelectorAll("ad-event-tracker").forEach((adet) => {(adet.closest("li") || adet).remove();});
        }

        function writeOver18Cookie(value) {
            if (over18State === value) {
                return;
            }
            over18State = value;
            document.cookie = value
                ? "over18=true; path=/; max-age=31536000"
                : "over18=; path=/; max-age=0";
        }

        function safeStorageGet(defaults, callback) {
            try {
                storage.sync.get(defaults, callback);
            } catch {}
        }

        function scanForBlurGates() {
            const now = Date.now();
            if (now - lastShadowScan < SHADOW_SCAN_INTERVAL_MS) {
                return;
            }
            lastShadowScan = now;
            purgeBlurGates(document);
        }

        function scheduleSweep() {
            if (sweepQueued) {
                return;
            }
            sweepQueued = true;
            const wait = Math.max(0, lastSweep + SWEEP_MIN_INTERVAL_MS - Date.now());
            setTimeout(() => {
                requestAnimationFrame(() => {
                    sweepQueued = false;
                    lastSweep = Date.now();
                    uncensor();
                });
            }, wait);
        }

        function uncensor() {
            if (theme) {
                theme.sweep();
            }
            if (settings.removeAds) {
                removeAdPosts();
            }
            if (!settings.enabled) {
                writeOver18Cookie("");
                removeStylesheetGuard();
                return;
            }
            installStylesheetGuard();
            writeOver18Cookie("true");
            XPROMO_IDS.forEach((id) => document.getElementById(id)?.remove());
            if (document.body) {
                document.body.classList.remove("rpl-scroll-lock");
            }
            revealBlurredContainers();
            enablePreviousNextArrowOnCarouselsMobile();
            revealXpromoContainers();
            promoteRevealedSlots();
            removeThumbnailShadows();
            unblurThumbnails();
            unblurFaceplateImgs();
            unblurHighlightCards();
            releasePostMediaContainment();
            scanForBlurGates();
        }

        function init() {
            safeStorageGet(SETTINGS_DEFAULTS, (stored) => {
                settings = { ...SETTINGS_DEFAULTS, ...stored };
                uncensor();
                lastSweep = Date.now();
            });

            if (theme) {
                theme.start();
            }

            const observer = new MutationObserver(scheduleSweep);
            observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ["style"],
            });

            try {
                storage.sync.onChanged.addListener((changes) => {
                    if (changes.enabled) {
                        settings.enabled = changes.enabled.newValue;
                    }
                    if (changes.removeAds) {
                        settings.removeAds = changes.removeAds.newValue;
                    }
                    uncensor();
                });
            } catch {}
        }

        return { init };
    }

    root.createUncensor = createUncensor;
})(window);
