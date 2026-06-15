class PauseHotkey {
    constructor() {
        this.isHandlingPause = false;
        this.isEnabled = true;
        this.TEXT = {
            settingsRu: '\u043d\u0430\u0441\u0442\u0440\u043e',
            pauseRu: '\u043f\u0430\u0443\u0437',
            breakRu: '\u043f\u0435\u0440\u0435\u0440\u044b\u0432',
            closeRu: '\u0437\u0430\u043a\u0440',
            notFound: '\u041d\u0435 \u043d\u0430\u0448\u0451\u043b \u043a\u043d\u043e\u043f\u043a\u0443 \u043f\u0430\u0443\u0437\u044b',
            unavailable: '\u041f\u0430\u0443\u0437\u0430 \u0441\u0435\u0439\u0447\u0430\u0441 \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u043d\u0430'
        };
        try {
            chrome.storage.sync.get({ pause_hotkey_enabled: true }, (settings) => {
                this.isEnabled = settings.pause_hotkey_enabled !== false;
            });
            chrome.runtime.onMessage.addListener((message) => {
                if (message.type === 'updateNotesSettings' && message.settings &&
                    typeof message.settings.pause_hotkey_enabled === 'boolean') {
                    this.isEnabled = message.settings.pause_hotkey_enabled;
                }
            });
        } catch (_) {}
        this.setupHotkey();
    }

    setupHotkey() {
        document.addEventListener('keydown', (e) => {
            if (!this.isEnabled) return;
            if (e.key !== 'F8' || e.repeat) return;

            e.preventDefault();
            e.stopPropagation();
            this.togglePause();
        }, true);
    }

    normalizeText(value) {
        return (value || '')
            .toString()
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
    }

    isVisible(node) {
        if (!node) return false;

        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') {
            return false;
        }

        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    getNodeIconHref(node) {
        const imgNode = node?.querySelector?.('img.button__icon');
        const imgSrc = imgNode?.getAttribute?.('src') || imgNode?.src || '';

        const useNode = node?.querySelector?.('use');
        return this.normalizeText(
            imgSrc ||
            useNode?.getAttribute?.('href') ||
            useNode?.getAttribute?.('xlink:href') ||
            ''
        );
    }

    matchesSettingsIcon(node) {
        const href = this.getNodeIconHref(node);
        if (!href) return false;

        return href.includes('#settings') ||
            href.includes('#setting') ||
            href.includes('#gear') ||
            href.includes('#cog') ||
            href.includes('#menu') ||
            href.includes('#more') ||
            href.includes('#options') ||
            href.includes('#option') ||
            href.includes('#dots') ||
            href.includes('#ellipsis') ||
            href.includes('e3a7cf4ee64b975985ad.svg');
    }

    matchesSettings(node) {
        const text = this.normalizeText(node?.textContent);
        const label = this.normalizeText(`${node?.getAttribute?.('aria-label') || ''} ${node?.getAttribute?.('title') || ''}`);
        const className = this.normalizeText(node?.className?.toString?.() || '');
        return text.includes(this.TEXT.settingsRu) ||
            label.includes(this.TEXT.settingsRu) ||
            label.includes('setting') ||
            className.includes('setting') ||
            className.includes('settings') ||
            className.includes('gear') ||
            className.includes('cog');
    }

    matchesPause(node) {
        const text = this.normalizeText(node?.textContent);
        const label = this.normalizeText(`${node?.getAttribute?.('aria-label') || ''} ${node?.getAttribute?.('title') || ''}`);
        const className = this.normalizeText(node?.className?.toString?.() || '');
        return text.includes(this.TEXT.pauseRu) ||
            text.includes('pause') ||
            text.includes(this.TEXT.breakRu) ||
            label.includes(this.TEXT.pauseRu) ||
            label.includes('pause') ||
            className.includes('pause');
    }

    showNotification(message, type = 'warning') {
        const notification = document.createElement('div');
        const backgroundColor = type === 'warning' ? 'rgba(255, 152, 0, 0.9)' : 'rgba(0, 0, 0, 0.8)';

        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: ${backgroundColor};
            color: white;
            padding: 12px 24px;
            border-radius: 8px;
            z-index: 10000;
            animation: fadeIn 0.3s ease-in-out;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            backdrop-filter: blur(5px);
            font-size: 14px;
        `;
        notification.textContent = message;
        document.body.appendChild(notification);

        setTimeout(() => {
            notification.style.animation = 'fadeOut 0.3s ease-in-out';
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }

    waitFor(checkFn, timeoutMs = 1800, intervalMs = 60) {
        return new Promise((resolve) => {
            const startedAt = Date.now();

            const tick = () => {
                const result = checkFn();
                if (result) {
                    resolve(result);
                    return;
                }

                if (Date.now() - startedAt >= timeoutMs) {
                    resolve(null);
                    return;
                }

                setTimeout(tick, intervalMs);
            };

            tick();
        });
    }

    getClickableFromNode(node) {
        if (!node || typeof node.closest !== 'function') return node || null;
        return node.closest(
            'button, [role="button"], [role="menuitem"], li, a, div.button, .button, .button-comp, .base-menu__item'
        ) || node;
    }

    getSettingsButtons() {
        const directSelectors = [
            '.button.preset-1.small.desktop-version img.button__icon[src*="e3a7cf4ee64b975985ad.svg"]',
            '.button.preset-1.small.desktop-version svg use[href$="#settings"]',
            '.button.preset-1.small.desktop-version svg use[xlink\\:href$="#settings"]',
            '.button.preset-1.small.desktop-version svg use[href*="#settings"]',
            '.button.preset-1.small.desktop-version svg use[xlink\\:href*="#settings"]',
            'img.button__icon[src*="e3a7cf4ee64b975985ad.svg"]',
            'use[href$="#settings"]',
            'use[href*="#settings"]',
            'svg use[href$="#settings"]',
            'use[xlink\\:href$="#settings"]',
            'use[xlink\\:href*="#settings"]',
            'svg use[xlink\\:href$="#settings"]',
            '[class*="settings"]',
            '[class*="gear"]',
            '[class*="cog"]',
            'button[aria-label*="setting"]',
            'button[title*="setting"]'
        ];

        const candidates = [];
        const seen = new Set();
        const pushCandidate = (node) => {
            const clickable = this.getClickableFromNode(node);
            if (!clickable || seen.has(clickable) || !this.isVisible(clickable)) {
                return;
            }

            seen.add(clickable);
            candidates.push(clickable);
        };

        for (const selector of directSelectors) {
            const match = document.querySelector(selector);
            pushCandidate(match);
        }

        const clickableCandidates = Array.from(document.querySelectorAll('button, [role="button"], .button, .button-comp, li, a, div'));
        clickableCandidates
            .filter((node) => this.matchesSettings(node) || this.matchesSettingsIcon(node))
            .forEach((node) => pushCandidate(node));

        const topControls = Array.from(document.querySelectorAll(
            '.button.preset-1.small.desktop-version, button.preset-1.small.desktop-version, div.button.preset-1.small.desktop-version'
        ));
        topControls
            .filter((node) => this.matchesSettingsIcon(node))
            .forEach((node) => pushCandidate(node));

        return candidates;
    }

    getSettingsButton() {
        return this.getSettingsButtons()[0] || null;
    }

    getSettingsMenuRoots() {
        const selectors = [
            '.game-room__settings',
            '.base-menu',
            '.base-menu__list',
            '.base-menu__content',
            '.dropdown-menu',
            '.context-menu',
            '[role="menu"]',
            '[class*="menu"]'
        ];

        const roots = [];
        const seen = new Set();

        selectors.forEach((selector) => {
            document.querySelectorAll(selector).forEach((root) => {
                if (seen.has(root)) return;
                seen.add(root);
                roots.push(root);
            });
        });

        return roots;
    }

    getPauseButton(onlyMenuRoots = false) {
        const directPauseSelectors = [
            'use[href$="#pause"]',
            'use[href*="#pause"]',
            'use[xlink\\:href$="#pause"]',
            'use[xlink\\:href*="#pause"]'
        ];

        if (!onlyMenuRoots) {
            for (const selector of directPauseSelectors) {
                const icon = document.querySelector(selector);
                const clickable = this.getClickableFromNode(icon);
                if (clickable) {
                    return clickable;
                }
            }
        }

        const searchRoots = onlyMenuRoots ? this.getSettingsMenuRoots() : [...this.getSettingsMenuRoots(), document.body];
        const selectors = [
            'button',
            '[role="button"]',
            '[role="menuitem"]',
            'li',
            'a',
            'span',
            'div'
        ];

        for (const root of searchRoots) {
            for (const selector of selectors) {
                const nodes = Array.from(root.querySelectorAll(selector));
                const found = nodes.find((node) => this.matchesPause(node));
                if (found) {
                    return this.getClickableFromNode(found);
                }
            }
        }

        return null;
    }

    isPauseDisabled(button) {
        if (!button) return false;

        const clickable = this.getClickableFromNode(button) || button;
        const ariaDisabled = clickable.getAttribute?.('aria-disabled');
        const className = this.normalizeText(clickable.className?.toString?.() || '');
        return clickable.classList?.contains('disabled') ||
            clickable.hasAttribute?.('disabled') ||
            ariaDisabled === 'true' ||
            className.includes('disabled');
    }

    getCloseButton() {
        const selectors = [
            '.game-room__settings .close',
            '.base-menu .close',
            '.context-menu .close',
            '[class*="menu"] [aria-label]',
            '[class*="menu"] button[title]',
            '[role="menu"] [aria-label]',
            '[role="menu"] button[title]'
        ];

        for (const selector of selectors) {
            const buttons = Array.from(document.querySelectorAll(selector));
            const found = buttons.find((node) => {
                const label = this.normalizeText(`${node.getAttribute?.('aria-label') || ''} ${node.getAttribute?.('title') || ''}`);
                return label.includes(this.TEXT.closeRu) || label.includes('close');
            });
            if (found) {
                return found;
            }
        }

        return null;
    }

    dispatchMouseClick(node) {
        const target = this.getClickableFromNode(node);
        if (!target) return false;

        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((eventName) => {
            const event = new MouseEvent(eventName, {
                view: window,
                bubbles: true,
                cancelable: true
            });
            target.dispatchEvent(event);
        });

        return true;
    }

    async ensureSettingsMenuOpen() {
        const existingPauseButton = this.getPauseButton(true);
        if (existingPauseButton) {
            return existingPauseButton;
        }

        const settingsButtons = this.getSettingsButtons();
        if (settingsButtons.length === 0) {
            return null;
        }

        for (const settingsButton of settingsButtons) {
            this.dispatchMouseClick(settingsButton);

            const pauseButton = await this.waitFor(() => this.getPauseButton(true), 700, 50);
            if (pauseButton) {
                return pauseButton;
            }
        }

        return null;
    }

    async togglePause() {
        if (this.isHandlingPause) {
            return;
        }

        this.isHandlingPause = true;

        try {
            const pauseButton = await this.ensureSettingsMenuOpen();

            if (!pauseButton) {
                this.showNotification(this.TEXT.notFound);
                return;
            }

            if (this.isPauseDisabled(pauseButton)) {
                this.getCloseButton()?.click();
                this.showNotification(this.TEXT.unavailable);
                return;
            }

            this.dispatchMouseClick(pauseButton);
            await new Promise((resolve) => setTimeout(resolve, 120));
            this.dispatchMouseClick(this.getCloseButton());
        } finally {
            setTimeout(() => {
                this.isHandlingPause = false;
            }, 250);
        }
    }

    autoJoinLobby() {
        console.log('Auto joining lobby');

        const tryClickButton = () => {
            const modal = document.querySelector('.common-room-modal.default-modal');

            if (!modal) {
                return false;
            }

            const startButton = modal.querySelector('button.button-comp.outline[data-v-102a3970][data-v-3ee51aab]');
            if (!startButton) {
                return false;
            }

            startButton.click();
            return true;
        };

        if (!tryClickButton()) {
            const observer = new MutationObserver(() => {
                if (tryClickButton()) {
                    observer.disconnect();
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: false
            });

            const interval = setInterval(() => {
                if (tryClickButton()) {
                    clearInterval(interval);
                }
            }, 100);

            setTimeout(() => {
                observer.disconnect();
                clearInterval(interval);
            }, 5000);
        }
    }
}

const style = document.createElement('style');
style.textContent = `
    @keyframes fadeIn {
        from { opacity: 0; transform: translateY(-10px); }
        to { opacity: 1; transform: translateY(0); }
    }
    @keyframes fadeOut {
        from { opacity: 1; transform: translateY(0); }
        to { opacity: 0; transform: translateY(-10px); }
    }
`;
document.head.appendChild(style);

window.pauseHotkey = new PauseHotkey();
