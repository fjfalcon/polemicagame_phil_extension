// Глобальный флаг автопринятия (загружается из настроек и может меняться из попапа)
let autoAcceptEnabled = true;
// Глобальный флаг запрета кликов по веб-камере
let disableWebcamClicks = false;
let skipStartScreenEnabled = true;
let autoHideRolesEnabled = false;
let rolePhaseAutoSwitchEnabled = false;
let resolveSettingsReady;
const settingsReady = new Promise((resolve) => {
    resolveSettingsReady = resolve;
});

const RU = {
    welcome: '\u0414\u043e\u0431\u0440\u043e \u043f\u043e\u0436\u0430\u043b\u043e\u0432\u0430\u0442\u044c',
    startUpper: '\u041d\u0410\u0427\u0410\u0422\u042c \u0418\u0413\u0420\u0423',
    start: '\u041d\u0430\u0447\u0430\u0442\u044c \u0438\u0433\u0440\u0443',
    recruiting: '\u0418\u0434\u0435\u0442 \u043d\u0430\u0431\u043e\u0440 \u0438\u0433\u0440\u043e\u043a\u043e\u0432',
    ready: '\u0413\u043e\u0442\u043e\u0432',
    confirm: '\u041f\u043e\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u044c',
    accept: '\u041f\u0440\u0438\u043d\u044f\u0442\u044c \u0438\u0433\u0440\u0443'
};
const EN = {
    welcome: 'Welcome',
    startUpper: 'START PLAYING',
    start: 'Start playing',
    recruiting: 'Recruiting players',
    ready: 'Ready',
    confirm: 'Confirm',
    accept: 'Start playing'
};
try {
    chrome.storage.sync.get({
        auto_accept_enabled: true,
        disable_webcam_clicks: false,
        skip_start_screen_enabled: true,
        auto_hide_roles_enabled: false,
        role_phase_auto_switch_enabled: false
    }, (res) => {
        autoAcceptEnabled = !!res.auto_accept_enabled;
        disableWebcamClicks = !!res.disable_webcam_clicks;
        skipStartScreenEnabled = res.skip_start_screen_enabled !== false;
        autoHideRolesEnabled = res.auto_hide_roles_enabled === true;
        rolePhaseAutoSwitchEnabled = autoHideRolesEnabled && res.role_phase_auto_switch_enabled === true;
        resolveSettingsReady();
        console.log('⚙️ auto_accept_enabled =', autoAcceptEnabled);
        console.log('⚙️ disable_webcam_clicks =', disableWebcamClicks);
    });
    // Реакция на обновления из попапа
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'updateNotesSettings' && message.settings) {
            if (typeof message.settings.auto_accept_enabled === 'boolean') {
                const newVal = message.settings.auto_accept_enabled;
                console.log('🔄 Обновление auto_accept_enabled =>', newVal);
                // Если выключили и автопринятие активно — останавливаем
                if (!newVal && window.autoGameAccept && window.autoGameAccept.isActive) {
                    window.stopAutoGameAccept();
                }
                autoAcceptEnabled = newVal;
                // Если включили на странице поиска — запускаем
                if (newVal && typeof isSearchPage === 'function' && isSearchPage()) {
                    safeStartAutoGame();
                }
            }
            if (typeof message.settings.disable_webcam_clicks === 'boolean') {
                const newVal = message.settings.disable_webcam_clicks;
                console.log('🔄 Обновление disable_webcam_clicks =>', newVal);
                disableWebcamClicks = newVal;
            }
            if (typeof message.settings.skip_start_screen_enabled === 'boolean') {
                skipStartScreenEnabled = message.settings.skip_start_screen_enabled;
            }
            if (typeof message.settings.auto_hide_roles_enabled === 'boolean') {
                autoHideRolesEnabled = message.settings.auto_hide_roles_enabled;
                if (!autoHideRolesEnabled) {
                    rolePhaseAutoSwitchEnabled = false;
                    window.showOwnRole?.();
                } else {
                    startInitialAutoHideRole();
                }
            }
            if (typeof message.settings.role_phase_auto_switch_enabled === 'boolean') {
                rolePhaseAutoSwitchEnabled = autoHideRolesEnabled && message.settings.role_phase_auto_switch_enabled;
            }
        }
    });
} catch (_) {
    resolveSettingsReady();
}

// Функция для автоматического старта игры
function autoStartGame() {
    console.log('🚀 Запуск автоматического принятия игр');
    let videoButtonClicked = false;
    
    function clickButtons() {
        console.log('🔍 Проверка наличия кнопок: ' + new Date().toLocaleTimeString());
        
        // Рщем любые элементы с текстом "Принять игру"
        const acceptGameElements = Array.from(document.querySelectorAll('*')).filter(el => 
            el.textContent && (el.textContent.includes(RU.accept) || el.textContent.includes(EN.accept))
        );
        console.log('🎮 Найдено элементов с текстом "Принять игру":', acceptGameElements.length);
        
        // Try to click the regular buttons
        const readyButtons = Array.from(document.querySelectorAll('button')).filter(btn => 
            btn.textContent.includes(RU.ready) ||
            btn.textContent.includes(RU.confirm) ||
            btn.textContent.includes(RU.start) ||
            btn.textContent.includes(RU.accept) ||
            btn.textContent.includes(EN.ready) ||
            btn.textContent.includes(EN.confirm) ||
            btn.textContent.includes(EN.start) ||
            btn.textContent.includes(EN.accept)
        );
        console.log('🔎 Найдено кнопок с нужным текстом:', readyButtons.length);
        
        // Look for game accept elements by multiple selectors
        const gameAcceptSelectors = [
            '.p-play__profile-accept.cursor-pointer',
            '.p-play__profile-game.p-play__profile-accept',
            '.p-play-profile__wr div[class*="cursor-pointer"]',
            '.p-play-profile__wr div'  // Вместо сложного селектора используем более простой
        ];
        
        let gameAcceptDivs = [];
        gameAcceptSelectors.forEach(selector => {
            try {
                const elements = Array.from(document.querySelectorAll(selector));
                // Фильтруем элементы, которые содержат текст "Принять игру" для селекторов, которые могут вернуть много элементов
                const filteredElements = selector === '.p-play-profile__wr div' 
                    ? elements.filter(el => el.textContent && (el.textContent.includes(RU.accept) || el.textContent.includes(EN.accept)))
                    : elements;
                
                if (filteredElements.length > 0) {
                    console.log(`📌 Поиск по селектору "${selector}": найдено ${filteredElements.length} элементов`);
                    gameAcceptDivs = [...gameAcceptDivs, ...filteredElements];
                }
            } catch (error) {
                console.log(`❌ Ошибка при поиске по селектору "${selector}":`, error.message);
            }
        });
        
        // Рщем по классам с помощью более безопасных селекторов
        try {
            const cursorPointerDivs = Array.from(document.querySelectorAll('div.cursor-pointer'));
            const acceptDivs = cursorPointerDivs.filter(div => 
                div.textContent && (div.textContent.includes(RU.accept) || div.textContent.includes(EN.accept))
            );
            
            if (acceptDivs.length > 0) {
                console.log(`📌 Найдено div с классом cursor-pointer и текстом "Принять игру": ${acceptDivs.length}`);
                gameAcceptDivs = [...gameAcceptDivs, ...acceptDivs];
            }
        } catch (error) {
            console.log(`❌ Ошибка при поиске div с классом cursor-pointer:`, error.message);
        }
        
        // Если с селекторами не получилось, ищем по содержимому текста и классам
        if (gameAcceptDivs.length === 0) {
            const candidateDivs = Array.from(document.querySelectorAll('div.cursor-pointer, div[class*="accept"]'));
            gameAcceptDivs = candidateDivs.filter(div => {
                const hasAcceptText = div.textContent && (div.textContent.includes(RU.accept) || div.textContent.includes(EN.accept));
                const hasModeText = div.textContent && (
                    div.textContent.includes('\u041A\u0443\u043B\u044C\u0442\u0443\u0440\u043D\u044B\u0439') || 
                    div.textContent.includes('\u041E\u0431\u044B\u0447\u043D\u044B\u0439') || 
                    div.textContent.includes('\u0411\u0435\u0437 \u0426\u0435\u043D\u0437\u0443\u0440\u044B')
                );
                return hasAcceptText || hasModeText;
            });
            if (gameAcceptDivs.length > 0) {
                console.log('🔎 Найдено дополнительных div для принятия игры:', gameAcceptDivs.length);
            }
        }
        
        // Специально для элемента из примера пользователя
        try {
            const profileAcceptElements = Array.from(document.querySelectorAll('.p-play__profile-accept'));
            if (profileAcceptElements.length > 0) {
                console.log(`📌 Найдено элементов .p-play__profile-accept: ${profileAcceptElements.length}`);
                gameAcceptDivs = [...gameAcceptDivs, ...profileAcceptElements];
            }
        } catch (error) {
            console.log(`❌ Ошибка при поиске .p-play__profile-accept:`, error.message);
        }
        
        // Удаляем дубликаты из списка
        gameAcceptDivs = [...new Set(gameAcceptDivs)];
        
        // Click regular buttons
        readyButtons.forEach(button => {
            console.log('🎯 Найдена кнопка:', button.textContent);
            button.click();
            console.log('✅ Клик по кнопке:', button.textContent);
            
            // After clicking start button, try to find and click video button once
            if (!videoButtonClicked) {
                setTimeout(() => {
                    const videoButton = document.querySelector('.button.preset-1.small.desktop-version');
                    
                    if (videoButton) {
                        if (disableWebcamClicks) {
                            console.log('⛔ Пропускаем автоклик веб-камеры (запрещено настройкой)');
                        } else {
                            console.log('🎥 Включаем видео...');
                            videoButton.click();
                            videoButtonClicked = true;
                        }
                    }
                }, 1000); // Wait 1 second after clicking start button
            }
        });
        
        // Click game accept divs
        gameAcceptDivs.forEach(div => {
            let modeText = '';
            const modeSpan = div.querySelector('span[style*="font-size"]');
            if (modeSpan) {
                modeText = modeSpan.textContent || '';
            } else {
                modeText = div.textContent || '';
            }
            
            const mode = modeText.includes('\u041A\u0443\u043B\u044c\u0442\u0443\u0440\u043D\u044B\u0439') ? '\u041A\u0443\u043B\u044c\u0442\u0443\u0440\u043D\u044B\u0439' : 
                        modeText.includes('\u041E\u0431\u044b\u0447\u043D\u044B\u0439') ? '\u041E\u0431\u044b\u0447\u043D\u044B\u0439' : 
                        modeText.includes('\u0411\u0435\u0437 \u0426\u0435\u043D\u0437\u0443\u0440\u044B') ? '\u0411\u0435\u0437 \u0426\u0435\u043D\u0437\u0443\u0440\u044B' : '\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439';
            
            console.log(`🎮 Найден элемент принятия игры с режимом: ${mode}`);
            console.log(`📝 HTML элемента:`, div.outerHTML);
            
            try {
                div.click();
                console.log(`✅ Клик по элементу режима: ${mode}`);
            } catch (error) {
                console.log(`❌ Ошибка при клике:`, error.message);
                
                // Попробуем другой подход - создание события
                try {
                    const clickEvent = new MouseEvent('click', {
                        view: window,
                        bubbles: true,
                        cancelable: true
                    });
                    div.dispatchEvent(clickEvent);
                    console.log(`✅ Клик через dispatchEvent для режима: ${mode}`);
                } catch (err) {
                    console.log(`❌ Не удалось создать событие клика:`, err.message);
                }
            }
        });
        
        // Если также нашли элемент через фильтр текста, кликаем и по нему
        acceptGameElements.forEach(el => {
            if (!readyButtons.includes(el) && !gameAcceptDivs.includes(el)) {
                console.log('🎲 Найден доп. элемент с текстом "Принять игру":', el.outerHTML);
                try {
                    el.click();
                    console.log('✅ Клик по доп. элементу с текстом "Принять игру"');
                } catch (error) {
                    console.log('❌ Ошибка при клике по доп. элементу:', error.message);
                }
            }
        });
    }

    // Создаем постоянный интервал для проверки каждую секунду
    const intervalId = setInterval(clickButtons, 1000);
    console.log('⏱️ Установлен постоянный интервал проверки каждую секунду');

    // Оакже настраиваем MutationObserver для мгновенной реакции на изменения DOM
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.addedNodes.length) {
                // При изменении DOM сразу проверяем наличие кнопок
                clickButtons();
                break;
            }
        }
    });

    // Наблюдаем за всем документом
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true
    });
    
    console.log('👁️ Установлено наблюдение за изменениями DOM (будет работать постоянно)');
    
    // Сохраняем информацию в window, чтобы избежать дублирования
    window.autoGameAccept = {
        intervalId: intervalId,
        observer: observer,
        isActive: true
    };
    
    // Добавляем функцию для остановки, если понадобится
    window.stopAutoGameAccept = function() {
        if (window.autoGameAccept && window.autoGameAccept.isActive) {
            clearInterval(window.autoGameAccept.intervalId);
            window.autoGameAccept.observer.disconnect();
            window.autoGameAccept.isActive = false;
            console.log('🛑 Автоматическое принятие игр остановлено');
            return true;
        }
        return false;
    };
}

// Функция для функционала игровой страницы (нажатие кнопки НАЧАТЬ РГРУ, выключение вебкамер, скрытие роли)
function gamePageFunctions() {
    console.log('🎮 Запуск функций игровой страницы');
    let toggleRolePressed = false;
    const roleVisibilityState = new WeakMap();
    let pendingRoleSyncTimer = null;
    let suppressRoleKeyHandlingUntil = 0;
    let rolePhaseInitialized = false;
    let lastManualRoleActionAt = 0;
    let trackedRolesVisible = null;

    function getRoleVisibilityTargets() {
        const selectors = [
            '.player__role.role.role.my-role',
            '.my-role .player__role.role.role',
            '.my-player .player__role.role.role',
            '.my-player .player__role.my-role',
            '.my-role .player__role.my-role'
        ];

        const targets = [];
        const seen = new Set();

        selectors.forEach((selector) => {
            document.querySelectorAll(selector).forEach((element) => {
                if (seen.has(element)) return;
                seen.add(element);
                targets.push(element);
            });
        });

        return targets;
    }

    function legacySetRoleVisibility(isVisible) {
        const roleElements = getRoleVisibilityTargets();
        if (roleElements.length === 0) {
            console.log('⚠️ Элементы роли не найдены для изменения видимости');
            return false;
        }

        roleElements.forEach((element) => {
            if (!roleVisibilityState.has(element)) {
                roleVisibilityState.set(element, {
                    display: element.style.display,
                    visibility: element.style.visibility,
                    opacity: element.style.opacity,
                    pointerEvents: element.style.pointerEvents
                });
            }

            const originalState = roleVisibilityState.get(element);
            if (isVisible) {
                element.style.display = originalState.display;
                element.style.visibility = originalState.visibility;
                element.style.opacity = originalState.opacity;
                element.style.pointerEvents = originalState.pointerEvents;
            } else {
                element.style.display = 'none';
                element.style.visibility = 'hidden';
                element.style.opacity = '0';
                element.style.pointerEvents = 'none';
            }
        });

        toggleRolePressed = !isVisible;
        console.log(isVisible ? '👁️ Роль показана прямым методом' : '🙈 Роль скрыта прямым методом');
        return true;
    }

    function getPrimaryOwnRoleElement(roleElements = getRoleVisibilityTargets()) {
        return roleElements[0] || null;
    }

    function getRoleUseHref(roleElement) {
        if (!roleElement) return '';

        const useElement = roleElement.querySelector('use');
        if (!useElement) return '';

        return (
            useElement.getAttribute('href') ||
            useElement.getAttribute('xlink:href') ||
            ''
        ).toLowerCase();
    }

    function isRoleElementActuallyVisible(roleElement) {
        if (!roleElement) return false;

        const style = window.getComputedStyle(roleElement);
        if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.opacity === '0'
        ) {
            return false;
        }

        const rect = roleElement.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function getOwnRoleState(roleElements = getRoleVisibilityTargets()) {
        const primaryElement = getPrimaryOwnRoleElement(roleElements);
        const href = getRoleUseHref(primaryElement);
        const nativeHidden = href.includes('#stop');
        const inlineHidden = roleElements.some((element) =>
            element.style.display === 'none' ||
            element.style.visibility === 'hidden' ||
            element.style.opacity === '0'
        );

        return {
            nativeHidden,
            inlineHidden,
            visible: isRoleElementActuallyVisible(primaryElement)
        };
    }

    function syncTrackedRolesVisibility(state = getOwnRoleState()) {
        if (state.nativeHidden) {
            trackedRolesVisible = false;
            return trackedRolesVisible;
        }

        if (state.visible && !state.inlineHidden) {
            trackedRolesVisible = true;
            return trackedRolesVisible;
        }

        return trackedRolesVisible;
    }

    function rememberRoleInlineState(roleElements) {
        roleElements.forEach((element) => {
            if (roleVisibilityState.has(element)) return;

            roleVisibilityState.set(element, {
                display: element.style.display,
                visibility: element.style.visibility,
                opacity: element.style.opacity,
                pointerEvents: element.style.pointerEvents
            });
        });
    }

    function applyInlineRoleVisibility(roleElements, isVisible) {
        rememberRoleInlineState(roleElements);

        roleElements.forEach((element) => {
            const originalState = roleVisibilityState.get(element) || {
                display: '',
                visibility: '',
                opacity: '',
                pointerEvents: ''
            };

            if (isVisible) {
                element.style.display = originalState.display;
                element.style.visibility = originalState.visibility;
                element.style.opacity = originalState.opacity;
                element.style.pointerEvents = originalState.pointerEvents;
            } else {
                element.style.display = 'none';
                element.style.visibility = 'hidden';
                element.style.opacity = '0';
                element.style.pointerEvents = 'none';
            }
        });
    }

    function clearPendingRoleSync() {
        if (!pendingRoleSyncTimer) return;

        clearTimeout(pendingRoleSyncTimer);
        pendingRoleSyncTimer = null;
    }

    function dispatchNativeRoleToggle() {
        suppressRoleKeyHandlingUntil = Date.now() + 250;

        const keyOptions = {
            key: 'd',
            code: 'KeyD',
            keyCode: 68,
            which: 68,
            bubbles: true,
            cancelable: true
        };

        document.dispatchEvent(new KeyboardEvent('keydown', keyOptions));
        document.dispatchEvent(new KeyboardEvent('keyup', keyOptions));
        return true;
    }

    function syncRoleStateFromDom() {
        const roleElements = getRoleVisibilityTargets();
        if (roleElements.length === 0) {
            return false;
        }

        const state = getOwnRoleState(roleElements);
        if (!state.nativeHidden && state.inlineHidden) {
            applyInlineRoleVisibility(roleElements, true);
        }

        const nextState = getOwnRoleState(roleElements);
        syncTrackedRolesVisibility(nextState);
        toggleRolePressed = nextState.nativeHidden || nextState.inlineHidden || !nextState.visible;
        return true;
    }

    function scheduleRoleStateSync(delayMs = 80) {
        clearPendingRoleSync();
        pendingRoleSyncTimer = setTimeout(() => {
            pendingRoleSyncTimer = null;
            syncRoleStateFromDom();
        }, delayMs);
    }

    function setRoleVisibility(isVisible) {
        const roleElements = getRoleVisibilityTargets();
        if (roleElements.length === 0) {
            console.log('Role elements were not found for visibility update');
            return false;
        }

        clearPendingRoleSync();

        const currentState = getOwnRoleState(roleElements);
        if (trackedRolesVisible === null) {
            syncTrackedRolesVisibility(currentState);
        }
        if (isVisible) {
            applyInlineRoleVisibility(roleElements, true);
        }

        const alreadyDesired = isVisible
            ? !currentState.nativeHidden && !currentState.inlineHidden && currentState.visible
            : currentState.nativeHidden || currentState.inlineHidden || !currentState.visible;

        if (alreadyDesired) {
            toggleRolePressed = !isVisible;
            return true;
        }

        const shouldUseNativeToggle = trackedRolesVisible !== isVisible;

        if (shouldUseNativeToggle) {
            dispatchNativeRoleToggle();
            trackedRolesVisible = isVisible;
            scheduleRoleStateSync(isVisible ? 100 : 60);
        } else {
            applyInlineRoleVisibility(roleElements, isVisible);
            scheduleRoleStateSync(60);
        }

        toggleRolePressed = !isVisible;
        return true;
    }

    window.hideOwnRole = () => setRoleVisibility(false);
    window.showOwnRole = () => setRoleVisibility(true);

    let rolePhaseCheckTimer = null;
    let lastDetectedRolePhase = null;
    let pendingNightRoleShowTimer = null;
    let nightAutoShowAttempts = 0;
    let nightAutoShowStartedAt = 0;

    function scheduleNightRoleAutoShow(delayMs) {
        if (pendingNightRoleShowTimer) {
            clearTimeout(pendingNightRoleShowTimer);
        }

        console.log('[NIGHT-SHOW] scheduled in ' + delayMs + 'ms');
        pendingNightRoleShowTimer = setTimeout(() => {
            pendingNightRoleShowTimer = null;
            console.log('[NIGHT-SHOW] FIRE! Showing roles now.');

            // 1) Убираем CSS-скрытие
            showAllRolesCSS();

            // 2) Нативный показ через D
            const roleElements = getRoleVisibilityTargets();
            const primary = getPrimaryOwnRoleElement(roleElements);
            const href = getRoleUseHref(primary);
            const nativeHidden = href.includes('#stop');
            console.log('[NIGHT-SHOW] nativeHidden=' + nativeHidden);

            if (nativeHidden) {
                dispatchNativeRoleToggle();
            }

            trackedRolesVisible = true;
        }, delayMs);
    }

    function detectRolePhase() {
        const body = document.body;
        if (body?.classList.contains('night')) { return 'night'; }
        if (body?.classList.contains('day')) { return 'day'; }

        const isNightText = (text) =>
            text.includes('\u043d\u043e\u0447') ||
            text.includes('\u0440\u0430\u0437\u0434\u0430\u0447\u0430 \u043a\u0430\u0440\u0442') ||
            text.includes('\u0445\u043e\u0434 \u043c\u0430\u0444\u0438\u0438') ||
            text.includes('\u0437\u043d\u0430\u043a\u043e\u043c\u0441\u0442\u0432\u043e \u043c\u0430\u0444\u0438\u0438') ||
            text.includes('\u043f\u0440\u043e\u0432\u0435\u0440\u043a') ||
            text.includes('night') ||
            text.includes('card deal') ||
            text.includes('dealing') ||
            text.includes('mafia') ||
            text.includes('check');

        const isDayText = (text) =>
            text.includes('\u0434\u0435\u043d\u044c') ||
            text.includes('\u0433\u043e\u043b\u043e\u0441') ||
            text.includes('\u0438\u0442\u043e\u0433\u0438') ||
            text.includes('\u0440\u0435\u0447\u044c \u0438\u0433\u0440\u043e\u043a\u0430') ||
            text.includes('\u0434\u043e\u043f. \u0440\u0435\u0447\u044c') ||
            text.includes('\u043f\u0440\u043e\u0449\u0430\u043b\u044c\u043d\u0430\u044f') ||
            text.includes('day') ||
            text.includes('vote') ||
            text.includes('voting') ||
            text.includes('results') ||
            text.includes('player\'s speech') ||
            text.includes('player speech') ||
            text.includes('speech') ||
            text.includes('additional speech') ||
            text.includes('farewell');

        const getTexts = (selector) => Array.from(document.querySelectorAll(selector))
            .map((el) => (el.textContent || '').toLowerCase().replace(/\s+/g, ' ').trim())
            .filter(Boolean);

        // 1) Текущий этап (.current) — высший приоритет
        const currentTexts = getTexts('.substage.current, .stage.current');
        if (currentTexts.length > 0) {
            console.log('[PHASE] current:', currentTexts.join(' | '));
            const curDay = currentTexts.some(isDayText);
            const curNight = currentTexts.some(isNightText);
            if (curDay && !curNight) { console.log('[PHASE] => DAY (current)'); return 'day'; }
            if (curNight && !curDay) { console.log('[PHASE] => NIGHT (current)'); return 'night'; }
            // Оба? "день" в текущем + "ночь" в текущем — приоритет день (речь игрока = день)
            if (curDay && curNight) { console.log('[PHASE] => DAY (current has both, day wins)'); return 'day'; }
        }

        // 2) Активный этап (.active)
        const activeTexts = getTexts('.substage.active, .stage.active');
        if (activeTexts.length > 0) {
            const actDay = activeTexts.some(isDayText);
            const actNight = activeTexts.some(isNightText);
            if (actDay && !actNight) { return 'day'; }
            if (actNight && !actDay) { return 'night'; }
            if (actDay && actNight) { return 'day'; }
        }

        // 3) Следующий этап (.next) — только если current/active не определили
        const nextTexts = getTexts('.substage.next, .stage.next');
        if (nextTexts.length > 0) {
            console.log('[PHASE] next:', nextTexts.join(' | '));
            const nxtDay = nextTexts.some(isDayText);
            const nxtNight = nextTexts.some(isNightText);
            if (nxtNight && !nxtDay) { console.log('[PHASE] => NIGHT (next)'); return 'night'; }
            if (nxtDay && !nxtNight) { console.log('[PHASE] => DAY (next)'); return 'day'; }
        }

        // 4) OBS panel
        if (window.obsFloatingPanel && typeof window.obsFloatingPanel.detectTimeOfDay === 'function') {
            const panelPhase = window.obsFloatingPanel.detectTimeOfDay();
            if (panelPhase === 'night' || panelPhase === 'day') { return panelPhase; }
        }

        // 5) Любые .stage/.substage — последний fallback
        const allTexts = getTexts('.substage, .stage');
        const allDay = allTexts.some(isDayText);
        const allNight = allTexts.some(isNightText);
        if (allDay && !allNight) { return 'day'; }
        if (allNight && !allDay) { return 'night'; }
        if (allDay && allNight) { return 'day'; }

        return lastDetectedRolePhase || 'day';
    }

    function applyRolePhase(phase) {
        console.log('[APPLY] phase=' + phase + ' enabled=' + rolePhaseAutoSwitchEnabled + ' lastPhase=' + lastDetectedRolePhase + ' init=' + rolePhaseInitialized);
        if (!rolePhaseAutoSwitchEnabled) {
            if (pendingNightRoleShowTimer) {
                clearTimeout(pendingNightRoleShowTimer);
                pendingNightRoleShowTimer = null;
            }
            return;
        }

        if (phase !== 'day' && phase !== 'night') {
            return;
        }

        // Only cancel the night timer when switching AWAY from night
        if (phase !== 'night' && pendingNightRoleShowTimer) {
            clearTimeout(pendingNightRoleShowTimer);
            pendingNightRoleShowTimer = null;
        }

        if (!rolePhaseInitialized) {
            rolePhaseInitialized = true;
            lastDetectedRolePhase = phase;

            if (phase === 'night') {
                nightAutoShowAttempts = 0;
                nightAutoShowStartedAt = Date.now();
                scheduleNightRoleAutoShow(3000);
            } else {
                nightAutoShowAttempts = 0;
                nightAutoShowStartedAt = 0;
                if (autoHideRolesEnabled) {
                    hideAllRolesCSS();
                    trackedRolesVisible = false;
                }
            }
            return;
        }

        if (phase === lastDetectedRolePhase) {
            return;
        }

        lastDetectedRolePhase = phase;

        if (phase === 'night') {
            nightAutoShowAttempts = 0;
            nightAutoShowStartedAt = Date.now();
            scheduleNightRoleAutoShow(3000);
            return;
        }

        nightAutoShowAttempts = 0;
        nightAutoShowStartedAt = 0;
        console.log('[DAY-HIDE] hiding roles via CSS');
        if (autoHideRolesEnabled) {
            hideAllRolesCSS();
            trackedRolesVisible = false;
        }
        return;
    }

    function queueRolePhaseCheck() {
        if (!rolePhaseAutoSwitchEnabled) return;
        if (rolePhaseCheckTimer) return;

        rolePhaseCheckTimer = setTimeout(() => {
            rolePhaseCheckTimer = null;
            const phase = detectRolePhase();
            applyRolePhase(phase);

            if (phase === 'night' && nightAutoShowStartedAt) {
                const ownRoleState = getOwnRoleState();
                const shouldRetryNightShow =
                    ownRoleState.nativeHidden &&
                    !pendingNightRoleShowTimer &&
                    nightAutoShowAttempts > 0 &&
                    nightAutoShowAttempts < 5 &&
                    lastManualRoleActionAt < nightAutoShowStartedAt &&
                    (Date.now() - nightAutoShowStartedAt) < 9000;

                if (shouldRetryNightShow) {
                    scheduleNightRoleAutoShow(700);
                }
            }
        }, 150);
    }

    function normalizeRoleMenuText(value) {
        return (value || '').toLowerCase().replace(/\s+/g, ' ').trim();
    }

    function handleRoleMenuClick(event) {
        const target = event.target?.closest?.('button, [role="button"], li, a, span, div');
        if (!target) return;

        const text = normalizeRoleMenuText(target.textContent);
        if (text.includes('\u043f\u043e\u043a\u0430\u0437\u0430\u0442\u044c \u0440\u043e\u043b\u0438') || text.includes('show roles')) {
            lastManualRoleActionAt = Date.now();
            trackedRolesVisible = true;
            scheduleRoleStateSync(120);
            return;
        }

        if (text.includes('\u0441\u043a\u0440\u044b\u0442\u044c \u0440\u043e\u043b\u0438') || text.includes('hide roles')) {
            lastManualRoleActionAt = Date.now();
            trackedRolesVisible = false;
            scheduleRoleStateSync(120);
        }
    }
    
    // Функция для нажатия на кнопку "НАЧАТЬ РГРУ" на черном экране
    function clickStartGameButton() {
        if (!skipStartScreenEnabled) {
            return;
        }

        const welcomeModal = document.querySelector('.common-room-modal');
        const modalText = (welcomeModal?.textContent || '').trim();
        const hasWelcomeText = modalText.includes(RU.welcome) || modalText.includes(EN.welcome);

        if (!welcomeModal) {
            console.log('⏳ Модальное окно "Добро пожаловать" не найдено, ждем...');
            return;
        }

        const startButtons = Array.from(welcomeModal.querySelectorAll('button')).filter(btn =>
            (btn.textContent || '').includes(RU.startUpper) || (btn.textContent || '').includes(RU.start) ||
            (btn.textContent || '').includes(EN.startUpper) || (btn.textContent || '').includes(EN.start)
        );

        if (!hasWelcomeText && startButtons.length === 0) {
            console.log('⏳ Приветственная модалка без кнопки старта, ждем...');
            return;
        }

        console.log('🎉 Найдено приветственное окно');

        if (startButtons.length > 0) {
            console.log('🎯 Найдена кнопка начала игры:', startButtons[0].textContent);
            startButtons[0].click();
            console.log('✅ Кликнуто по кнопке начала игры');
        }
        
        // Рщем кнопки с текстом "НАЧАТЬ РГРУ" среди других элементов
        const startElements = Array.from(welcomeModal.querySelectorAll('*')).filter(el => 
            el.textContent && 
            (el.textContent.trim() === RU.startUpper || el.textContent.trim() === RU.start ||
             el.textContent.trim() === EN.startUpper || el.textContent.trim() === EN.start) &&
            !startButtons.includes(el)
        );
        
        if (startElements.length > 0) {
            console.log('🎲 Найден доп. элемент с текстом "НАЧАТЬ РГРУ":', startElements[0].outerHTML);
            try {
                startElements[0].click();
                console.log('✅ Клик по доп. элементу с текстом "НАЧАТЬ РГРУ"');
            } catch (error) {
                console.log('❌ Ошибка при клике по доп. элементу:', error.message);
            }
        }
    }
    
    // Функция для проверки, находимся ли мы в лобби
    function isInLobby() {
        // Проверяем наличие элементов лобби
        const stageName = document.querySelector('.new-stage__name');
        const invitationLink = document.querySelector('.invitation-link');

        // Проверяем текст "Рдет набор игроков"
        const isRecruiting = stageName && stageName.textContent.trim() === RU.recruiting;
        // Проверяем наличие ссылки для приглашения
        const hasInvitationLink = invitationLink !== null;

        return isRecruiting && hasInvitationLink;
    }

    // Функция для отключения вебкамер
    function disableWebcams() {
        // Проверяем, находимся ли мы в лобби
        if (!isInLobby()) {
            console.log('🏠 Не в лобби - пропускаем отключение вебкамеры');
            return;
        }

        // Проверяем, была ли уже отключена вебкамера
        if (window.webcamDisabled) {
            return;
        }

        // Уважаем настройку запрета кликов по веб-камере
        if (disableWebcamClicks) {
            console.log('🚫 Отключение вебкамеры запрещено настройками');
            return;
        }

        // Рщем кнопку вебкамеры
        const webcamButton = document.querySelector('div.button.preset-1.small.desktop-version');

        if (webcamButton) {
            // Проверяем, выключена ли камера (есть класс 'off')
            const isCameraOff = webcamButton.classList.contains('off');

            if (isCameraOff) {
                console.log('📷 Камера уже выключена');
                window.webcamDisabled = true;
                return;
            }

            console.log('🎥 Камера включена, отключаем...');

            try {
                // Проверяем иконку для дополнительной проверки
                const buttonImg = webcamButton.querySelector('img.button__icon');
                if (buttonImg && buttonImg.src.includes('516810fd6c1e38f17335.svg')) {
                    console.log('🎯 Подтверждено: камера включена (иконка включенной камеры)');
                }

                // Кликаем по кнопке до тех пор, пока камера не выключится
                let clickCount = 0;
                const maxClicks = 10; // Максимум 10 кликов для безопасности

                const clickInterval = setInterval(() => {
                    if (clickCount >= maxClicks) {
                        console.log('⚠️ Превышен лимит кликов по кнопке вебкамеры');
                        clearInterval(clickInterval);
                        return;
                    }

                    // Проверяем текущее состояние
                    const currentButton = document.querySelector('div.button.preset-1.small.desktop-version');
                    if (!currentButton) {
                        console.log('❌ Кнопка вебкамеры пропала');
                        clearInterval(clickInterval);
                        return;
                    }

                    const currentlyOff = currentButton.classList.contains('off');

                    if (currentlyOff) {
                        console.log(`✅ Камера выключена после ${clickCount} кликов`);
                        window.webcamDisabled = true;
                        clearInterval(clickInterval);
                        return;
                    }

                    // Кликаем
                    currentButton.click();
                    clickCount++;
                    console.log(`🔎 Клик ${clickCount} по кнопке вебкамеры`);

                }, 200); // Кликаем каждые 200мс

            } catch (error) {
                console.log('❌ Ошибка при отключении вебкамеры:', error.message);
            }
        } else {
            console.log('🔍 Кнопка вебкамеры не найдена');
        }
    }
    
    // Глобальное CSS-скрытие ВСЕХ ролей через <style> тег (поиск по ID в DOM)
    const ROLE_HIDE_ID = 'polemica-role-hide';
    const ROLE_HIDE_CSS = `
        .player__role,
        .player__role.role,
        svg.role,
        .my-role .player__role,
        .my-player .player__role {
            visibility: hidden !important;
            opacity: 0 !important;
            pointer-events: none !important;
        }
    `;

    function hideAllRolesCSS() {
        if (document.getElementById(ROLE_HIDE_ID)) return;
        const el = document.createElement('style');
        el.id = ROLE_HIDE_ID;
        el.textContent = ROLE_HIDE_CSS;
        (document.head || document.documentElement).appendChild(el);
        console.log('[ROLE-CSS] HIDDEN');
    }

    function showAllRolesCSS() {
        const el = document.getElementById(ROLE_HIDE_ID);
        if (!el) {
            console.log('[ROLE-CSS] show called but no style found!');
            return;
        }
        el.remove();
        console.log('[ROLE-CSS] SHOWN');
    }

    function isRolesHiddenByCSS() {
        return !!document.getElementById(ROLE_HIDE_ID);
    }

    function autoHideRole() {
        if (!autoHideRolesEnabled) {
            return false;
        }

        // Всегда прячем CSS. Ночью scheduleNightRoleAutoShow уберёт CSS через 3 сек.
        hideAllRolesCSS();
        trackedRolesVisible = false;
        return true;
    }

    let initialAutoHideTimer = null;
    let initialAutoHideAttempts = 0;

    function stopInitialAutoHideRole() {
        if (initialAutoHideTimer) {
            clearInterval(initialAutoHideTimer);
            initialAutoHideTimer = null;
        }
        initialAutoHideAttempts = 0;
    }

    function startInitialAutoHideRole() {
        stopInitialAutoHideRole();
        if (!autoHideRolesEnabled) {
            return;
        }

        initialAutoHideTimer = setInterval(() => {
            initialAutoHideAttempts += 1;

            if (!autoHideRolesEnabled) {
                stopInitialAutoHideRole();
                return;
            }

            if (autoHideRole()) {
                stopInitialAutoHideRole();
                return;
            }

            if (initialAutoHideAttempts >= 100) {
                stopInitialAutoHideRole();
            }
        }, 100);
    }
    
    // Обработчик нажатия клавиши D — ручное управление
    function handleKeyPress(event) {
        if (event.key === 'd' || event.key === 'D' || event.key === 'в' || event.key === 'В') {
            if (Date.now() < suppressRoleKeyHandlingUntil) {
                return;
            }

            lastManualRoleActionAt = Date.now();

            // Если роли скрыты CSS — убираем CSS, показываем роли
            if (isRolesHiddenByCSS()) {
                showAllRolesCSS();
                trackedRolesVisible = true;
                return;
            }

            // Нет inline-скрытия — обычный toggle
            if (trackedRolesVisible === null) {
                syncTrackedRolesVisibility();
            }
            trackedRolesVisible = !trackedRolesVisible;
            console.log('🎭 D: toggle, trackedRolesVisible=' + trackedRolesVisible);
        }
    }
    
    // Проверяем и выполняем действия каждую секунду
    const gameInterval = setInterval(() => {
        clickStartGameButton();
        disableWebcams();
        queueRolePhaseCheck();
    }, 1000);

    syncTrackedRolesVisibility();
    startInitialAutoHideRole();
    
    // Добавляем обработчик нажатия клавиш
    document.addEventListener('keydown', handleKeyPress, true);
    document.addEventListener('click', handleRoleMenuClick, true);
    
    // Оакже настраиваем MutationObserver для быстрой реакции
    const gameObserver = new MutationObserver((mutations) => {
        // Ўмотрим, есть ли изменения, которые могут указывать на появление игрового интерфейса
        for (const mutation of mutations) {
            if (mutation.addedNodes.length) {
                clickStartGameButton();
                disableWebcams();
                queueRolePhaseCheck();
                
                // CSS уже глобально прячет роли, ничего дополнительного не нужно
                break;
            }
        }
    });
    
    // Наблюдаем за всем документом
    gameObserver.observe(document.documentElement, {
        childList: true,
        subtree: true
    });
    
    console.log('👁️ Установлено наблюдение за игровой страницей');
    
    // Попытка автоматического скрытия роли при загрузке
    setTimeout(() => {
        queueRolePhaseCheck();
    }, 2000);
    
    // Сохраняем информацию, чтобы избежать дублирования
    window.gamePageTools = {
        gameInterval: gameInterval,
        gameObserver: gameObserver,
        isActive: true,
        keyListener: handleKeyPress
        , roleMenuClickListener: handleRoleMenuClick
    };
    
    // Функция для остановки
    window.stopGamePageFunctions = function() {
        if (window.gamePageTools && window.gamePageTools.isActive) {
            clearInterval(window.gamePageTools.gameInterval);
            stopInitialAutoHideRole();
            window.gamePageTools.gameObserver.disconnect();
            document.removeEventListener('keydown', window.gamePageTools.keyListener, true);
            document.removeEventListener('click', window.gamePageTools.roleMenuClickListener, true);
            if (rolePhaseCheckTimer) {
                clearTimeout(rolePhaseCheckTimer);
                rolePhaseCheckTimer = null;
            }
            if (pendingNightRoleShowTimer) {
                clearTimeout(pendingNightRoleShowTimer);
                pendingNightRoleShowTimer = null;
            }
            clearPendingRoleSync();
            window.gamePageTools.isActive = false;
            console.log('🛑 Функции игровой страницы остановлены');
            return true;
        }
        return false;
    };
}

// Функция для запуска только если нет активного наблюдения
function safeStartAutoGame() {
    if (!autoAcceptEnabled) {
        console.log('⛔ Автопринятие отключено настройкой');
        return;
    }
    if (!window.autoGameAccept || !window.autoGameAccept.isActive) {
        autoStartGame();
    } else {
        console.log('⚠️ Автоматическое принятие игр уже активно');
    }
}

// Функция для запуска функций игровой страницы
function safeStartGamePage() {
    if (!window.gamePageTools || !window.gamePageTools.isActive) {
        gamePageFunctions();
    } else {
        console.log('⚠️ Функции игровой страницы уже активны');
    }
}

// Функция для проверки, находимся ли мы на странице поиска игры
function isSearchPage() {
    const searchUrls = [
        'https://polemicagames.kz/game-search',
        'https://polemicagame.com/game-search'
    ];
    
    // Проверяем точное совпадение URL или URL с дополнительными параметрами
    return searchUrls.some(url => 
        location.href === url || 
        location.href.startsWith(url + '?') || 
        location.href.startsWith(url + '#')
    );
}

// Функция для проверки, находимся ли мы на игровой странице
function isGamePage() {
    return location.href.includes('https://polemicagame.com/game');
}

// Функция, запускающая нужные функции в зависимости от страницы
function checkAndStart() {
    console.log('🔍 Проверка URL:', location.href);
    
    if (isSearchPage()) {
        console.log('✅ Обнаружена страница поиска игры: ' + location.href);
        safeStartAutoGame();
        
        // Останавливаем функции игровой страницы, если активны
        if (window.gamePageTools && window.gamePageTools.isActive) {
            window.stopGamePageFunctions();
        }
    } 
    else if (isGamePage()) {
        console.log('✅ Обнаружена игровая страница: ' + location.href);
        safeStartGamePage();
        
        // Останавливаем автопринятие игр, если активно
        if (window.autoGameAccept && window.autoGameAccept.isActive) {
            window.stopAutoGameAccept();
        }
    } 
    else {
        console.log('❌ Скрипт не будет запущен на странице: ' + location.href);
        
        // Останавливаем все активные функции
        if (window.autoGameAccept && window.autoGameAccept.isActive) {
            window.stopAutoGameAccept();
        }
        
        if (window.gamePageTools && window.gamePageTools.isActive) {
            window.stopGamePageFunctions();
        }
    }
}

// Run on page load
function checkAndStartAfterSettingsReady() {
    settingsReady.then(checkAndStart);
}

window.addEventListener('load', checkAndStartAfterSettingsReady);

// Run immediately if page is already loaded
if (document.readyState === 'complete') {
    checkAndStartAfterSettingsReady();
}

// Run when URL changes (for single-page apps)
let lastUrl = location.href;
new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
        lastUrl = url;
        console.log('🔄 URL изменился на', url);
        checkAndStartAfterSettingsReady();
    }
}).observe(document, {subtree: true, childList: true});
