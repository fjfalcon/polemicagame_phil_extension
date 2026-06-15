/**
 * Плавающая панель OBS сцен для страницы игры
 */

class FloatingOBSPanel {
    constructor() {
        this.panel = null;
        this.isVisible = false;
        this.isDragging = false;
        this.dragStartX = 0;
        this.dragStartY = 0;
        this.panelStartX = 0;
        this.panelStartY = 0;
        this.scenes = [];
        this.currentScene = null;
        this.isEnabled = false;
        this.obsSessionId = null;

        // Настройки автоматического режима
        this.autoModeEnabled = false;
        this.dayScene = '';
        this.nightScene = '';
        this.currentTimeOfDay = null; // 'day' или 'night'
        this.domObserver = null;
        this.timeOfDayCheckDebounceTimer = null;
        this.timeOfDayCheckQueued = false;
        this.pendingTimeOfDay = null;
        this.pendingTimeOfDayConfirmTimer = null;
        this.pendingRoleVisibilityTimer = null;
        this.lastAppliedRoleVisibility = null;
        this.roleVisibilityDelayMs = 3000;
        this.roleVisibilityState = new WeakMap();

        // Отслеживание активной сцены
        this.sceneTrackingInterval = null;
        this.lastTrackedScene = null;

        // Resize functionality
        this.isResizing = false;
        this.resizeStartX = 0;
        this.resizeStartY = 0;
        this.startWidth = 0;
        this.startHeight = 0;
        this.minWidth = 240;
        this.minHeight = 160;
        this.maxWidth = 800;
        this.maxHeight = 600;
        this.gameUiObserver = null;
        this.gameUiCheckDebounceTimer = null;
        this.isGameUiVisible = false;

        this.init();
    }

    async init() {
        // Проверяем настройки при инициализации
        await this.loadSettings();

        if (this.isEnabled && this.hasActiveGameInterface()) {
            this.createPanel();
        }

        if (this.isEnabled || this.autoModeEnabled) {
            const status = await this.requestOBSStatus();
            await this.restorePersistedAutoState(status);
        }

        this.startGameUiMonitoring();
        this.syncPanelVisibilityWithGameState();

        // Слушаем сообщения от popup и background
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            console.log('📩 Floating panel received runtime message:', message);
            this.handleMessage(message, sender, sendResponse);
            return true; // Указываем что можем отвечать асинхронно
        });

        // Слушаем изменения в настройках
        chrome.storage.onChanged.addListener((changes, namespace) => {
            if (changes.obs_floating_panel_enabled) {
                this.isEnabled = changes.obs_floating_panel_enabled.newValue;
                if (this.isEnabled) {
                    this.show();
                } else {
                    this.hide();
                }
            }

            // Обработка изменений настроек автоматического режима
            if (changes.obs_auto_mode_enabled || changes.obs_day_scene || changes.obs_night_scene) {
                const newAutoMode = changes.obs_auto_mode_enabled?.newValue ?? this.autoModeEnabled;
                const newDayScene = changes.obs_day_scene?.newValue ?? this.dayScene;
                const newNightScene = changes.obs_night_scene?.newValue ?? this.nightScene;

                const settingsChanged = newAutoMode !== this.autoModeEnabled ||
                                      newDayScene !== this.dayScene ||
                                      newNightScene !== this.nightScene;

                if (settingsChanged) {
                    this.autoModeEnabled = newAutoMode;
                    this.dayScene = newDayScene;
                    this.nightScene = newNightScene;

                    console.log('Auto scene settings changed:', {
                        autoModeEnabled: this.autoModeEnabled,
                        dayScene: this.dayScene,
                        nightScene: this.nightScene
                    });

                    // Всегда запускаем мониторинг при включенном авторежиме
                    if (this.autoModeEnabled) {
                        this.startDOMMonitoring();
                    } else {
                        this.stopDOMMonitoring();
                    }
                }
            }
        });

        // Автоматически запускаем определение времени суток при загрузке
        this.startAutoTimeDetection();
    }

    async loadSettings() {
        try {
            const settings = await chrome.storage.sync.get([
                'obs_floating_panel_enabled',
                'obs_auto_mode_enabled',
                'obs_day_scene',
                'obs_night_scene'
            ]);
            this.isEnabled = settings.obs_floating_panel_enabled || false;
            this.autoModeEnabled = settings.obs_auto_mode_enabled || false;
            this.dayScene = settings.obs_day_scene || '';
            this.nightScene = settings.obs_night_scene || '';
        } catch (error) {
            console.error('Failed to load floating panel settings:', error);
        }
    }

    hasActiveGameInterface() {
        const playerCount = document.querySelectorAll('.player.desktop-version:not(.judge-player), .player.desktop-version.hidden:not(.judge-player)').length;
        const webcamCount = document.querySelectorAll('.player__video-wrapper, .player__video').length;
        const gameControlCount = document.querySelectorAll(
            '.button.preset-1.small.desktop-version, .game-room__settings, .player__menu.with-role, .player__role.role.role'
        ).length;

        return (playerCount >= 10 || webcamCount >= 10 || (playerCount >= 8 && webcamCount >= 8)) && gameControlCount > 0;
    }

    queueGameUiStateCheck() {
        if (this.gameUiCheckDebounceTimer) return;

        this.gameUiCheckDebounceTimer = setTimeout(() => {
            this.gameUiCheckDebounceTimer = null;
            this.syncPanelVisibilityWithGameState();
        }, 150);
    }

    startGameUiMonitoring() {
        if (this.gameUiObserver || !document.body) {
            return;
        }

        this.gameUiObserver = new MutationObserver(() => {
            this.queueGameUiStateCheck();
        });

        this.gameUiObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style']
        });
    }

    syncPanelVisibilityWithGameState() {
        const hasGameUi = this.hasActiveGameInterface();
        this.isGameUiVisible = hasGameUi;

        if (!hasGameUi) {
            if (this.isVisible) {
                this.hide();
            }
            return;
        }

        if (this.isEnabled && !this.isVisible) {
            this.show();
        }
    }

    async savePersistedAutoState() {
        if (!this.autoModeEnabled || !this.currentTimeOfDay) {
            return;
        }

        try {
            if (!this.obsSessionId) {
                const connectionState = await this.getStoredConnectionState();
                this.obsSessionId = connectionState?.sessionId || null;
            }

            if (!this.obsSessionId) {
                return;
            }

            await chrome.storage.local.set({
                obs_auto_scene_state: {
                    sessionId: this.obsSessionId,
                    currentTimeOfDay: this.currentTimeOfDay,
                    lastAppliedRoleVisibility: this.lastAppliedRoleVisibility,
                    timestamp: Date.now()
                }
            });
        } catch (error) {
            console.error('Failed to save OBS auto scene state:', error);
        }
    }

    async getStoredConnectionState() {
        try {
            return (await chrome.storage.local.get(['obs_connection_state'])).obs_connection_state || null;
        } catch (error) {
            console.error('Failed to load OBS connection state:', error);
            return null;
        }
    }

    async clearPersistedAutoState(resetRuntimeState = false) {
        try {
            await chrome.storage.local.remove('obs_auto_scene_state');
        } catch (error) {
            console.error('Failed to clear OBS auto scene state:', error);
        }

        if (resetRuntimeState) {
            if (this.pendingRoleVisibilityTimer) {
                clearTimeout(this.pendingRoleVisibilityTimer);
                this.pendingRoleVisibilityTimer = null;
            }
            this.obsSessionId = null;
            this.currentTimeOfDay = null;
            this.lastAppliedRoleVisibility = null;
        }
    }

    async restorePersistedAutoState(status = null) {
        if (!this.autoModeEnabled) {
            return false;
        }

        try {
            const resolvedStatus = status || await this.getStoredConnectionState();
            if (!resolvedStatus?.connected || !resolvedStatus.sessionId) {
                return false;
            }

            this.obsSessionId = resolvedStatus.sessionId;
            this.currentScene = resolvedStatus.currentScene || this.currentScene;
            this.scenes = resolvedStatus.scenes || this.scenes;

            const stored = (await chrome.storage.local.get(['obs_auto_scene_state'])).obs_auto_scene_state;
            if (!stored || stored.sessionId !== this.obsSessionId || !stored.currentTimeOfDay) {
                return false;
            }

            this.currentTimeOfDay = stored.currentTimeOfDay;
            this.lastAppliedRoleVisibility = stored.lastAppliedRoleVisibility || null;

            const applied = this.applyRoleVisibility(this.currentTimeOfDay === 'night');
            if (!applied) {
                this.scheduleRoleVisibility(this.currentTimeOfDay, 1);
            }

            await this.autoSwitchScene(this.currentTimeOfDay);
            console.log('Restored persisted OBS auto scene state:', stored);
            return true;
        } catch (error) {
            console.error('Failed to restore OBS auto scene state:', error);
            return false;
        }
    }

    handleMessage(message, sender, sendResponse) {
        console.log('Floating panel received message:', message.type, message);

        switch (message.type) {
            case 'obs_event':
                this.handleOBSEvent(message.eventType, message.data);
                if (sendResponse) sendResponse({ success: true });
                break;

            case 'floating_panel_toggle':
                this.toggle();
                if (sendResponse) sendResponse({ success: true });
                break;

            case 'floating_panel_show':
                this.show();
                if (sendResponse) sendResponse({ success: true });
                break;

            case 'floating_panel_hide':
                this.hide();
                if (sendResponse) sendResponse({ success: true });
                break;

            case 'auto_scene_settings_updated':
                this.autoModeEnabled = message.settings.obs_auto_mode_enabled;
                this.dayScene = message.settings.obs_day_scene;
                this.nightScene = message.settings.obs_night_scene;
                console.log('Auto scene settings updated:', {
                    autoModeEnabled: this.autoModeEnabled,
                    dayScene: this.dayScene,
                    nightScene: this.nightScene
                });
                if (sendResponse) sendResponse({ success: true });
                break;
        }

        return true; // Указываем что будем отвечать асинхронно
    }

    handleOBSEvent(eventType, data) {
        console.log('Floating panel received OBS event:', eventType, data);

        switch (eventType) {
            case 'obs_scenes_updated':
                if (data && data.scenes) {
                    this.scenes = data.scenes;
                    this.currentScene = data.currentScene;

                    // Создаем панель если она не существует и авторежим включен
                    if (!this.panel && this.autoModeEnabled && this.hasActiveGameInterface()) {
                        console.log('Creating panel for auto mode...');
                        this.createPanel();
                    }

                    this.updateScenesDisplay();
                    this.updateConnectionStatus('Подключено', 'connected');
                } else {
                    console.log('No scenes data received');
                }
                break;

            case 'obs_scene_changed':
                console.log('Scene changed in floating panel to:', data);
                this.currentScene = data;

                // Создаем панель если она не существует и авторежим включен
                if (!this.panel && this.autoModeEnabled && this.hasActiveGameInterface()) {
                    console.log('Creating panel for scene change...');
                    this.createPanel();
                }

                this.updateCurrentSceneHighlight();
                break;

            case 'obs_disconnected':
                console.log('OBS disconnected in floating panel');
                this.clearPersistedAutoState(true);
                this.scenes = [];
                this.currentScene = null;

                // Создаем панель если она не существует и авторежим включен
                if (!this.panel && this.autoModeEnabled && this.hasActiveGameInterface()) {
                    console.log('Creating panel for disconnect...');
                    this.createPanel();
                }

                this.updateScenesDisplay();
                this.updateConnectionStatus('Не подключено', 'error');
                break;
        }
    }

    createPanel() {
        if (this.panel) return;

        // Создаем основной контейнер панели
        this.panel = document.createElement('div');
        this.panel.id = 'obs-floating-panel';
        this.panel.innerHTML = `
            <div class="obs-panel-header">
                <span class="obs-panel-title">OBS Scenes</span>
                <div class="obs-panel-controls">
                    <button class="obs-panel-minimize" title="Свернуть">−</button>
                    <button class="obs-panel-close" title="Закрыть">×</button>
                </div>
            </div>
            <div class="obs-panel-content">
                <div class="obs-connection-status">Подключение...</div>
                <div class="obs-scenes-container">
                    <div class="obs-no-scenes">Нет доступных сцен</div>
                </div>
            </div>
            <div class="obs-resize-handle" title="Изменить размер"></div>
        `;

        // Добавляем стили
        this.addStyles();

        // Добавляем обработчики событий
        this.setupEventHandlers();

        // Добавляем панель на страницу
        document.body.appendChild(this.panel);

        // Загружаем позицию из localStorage
        this.loadPosition();
        this.loadSize();

        console.log('OBS Floating Panel created');
    }

    addStyles() {
        if (document.getElementById('obs-floating-panel-styles')) return;

        const styles = document.createElement('style');
        styles.id = 'obs-floating-panel-styles';
        styles.textContent = `
            #obs-floating-panel {
                position: fixed;
                top: 20px;
                right: 20px;
                height: 220px;
                width: 280px;
                min-width: 240px;
                min-height: 160px;
                max-width: 800px;
                max-height: 600px;
                background: linear-gradient(135deg, rgba(0, 0, 0, 0.35), rgba(147, 70, 255, 0.18) 55%, rgba(0, 0, 0, 0.25));
                border: none;
                border-radius: 10px;
                box-shadow: none;
                backdrop-filter: blur(6px);
                z-index: 99999;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                font-size: 13px;
                color: rgba(255, 255, 255, 0.92);
                user-select: none;
                transition: opacity 0.15s ease;
                transform-origin: top right;
                display: flex;
                flex-direction: column;
            }

            #obs-floating-panel.minimized {
                height: 28px;
                overflow: hidden;
            }

            #obs-floating-panel.dragging {
                transition: none;
                transform: none;
            }

            #obs-floating-panel.resizing {
                transition: none;
            }

            .obs-panel-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 6px 8px;
                background: transparent;
                border-radius: 10px 10px 0 0;
                cursor: move;
                border-bottom: none;
                flex-shrink: 0;
            }

            .obs-panel-title {
                font-weight: 500;
                font-size: 12px;
                color: rgba(255, 255, 255, 0.75);
                display: flex;
                align-items: center;
                gap: 6px;
            }

            .obs-panel-controls {
                display: flex;
                gap: 6px;
                opacity: 0;
                pointer-events: none;
                transition: opacity 0.15s ease;
            }

            #obs-floating-panel:hover .obs-panel-controls {
                opacity: 0.9;
                pointer-events: auto;
            }

            .obs-panel-minimize,
            .obs-panel-close {
                width: 18px;
                height: 18px;
                border: none;
                border-radius: 4px;
                background: transparent;
                color: rgba(255, 255, 255, 0.75);
                cursor: pointer;
                font-size: 14px;
                font-weight: 600;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: background 0.15s ease, color 0.15s ease;
            }

            .obs-panel-minimize:hover,
            .obs-panel-close:hover {
                background: rgba(255, 255, 255, 0.08);
                color: rgba(255, 255, 255, 0.95);
            }

            .obs-panel-content {
                padding: 8px;
                flex: 1;
                display: flex;
                flex-direction: column;
                overflow: hidden;
            }

            .obs-connection-status {
                text-align: center;
                padding: 6px 8px;
                border-radius: 8px;
                font-size: 12px;
                margin-bottom: 8px;
                background: rgba(0, 0, 0, 0.12);
                color: rgba(255, 255, 255, 0.65);
                border: none;
            }

            .obs-connection-status.connected {
                background: rgba(0, 0, 0, 0.12);
                color: rgba(255, 255, 255, 0.85);
            }

            .obs-connection-status.error {
                background: rgba(0, 0, 0, 0.12);
                color: rgba(255, 255, 255, 0.85);
            }

            .obs-scenes-container {
                display: flex;
                flex-direction: column;
                gap: 6px;
                flex: 1;
                overflow-y: auto;
            }

            .obs-no-scenes {
                text-align: center;
                color: rgba(255, 255, 255, 0.55);
                font-size: 12px;
                padding: 20px;
                font-style: italic;
            }

            .obs-scene-item {
                padding: 7px 10px;
                background: rgba(0, 0, 0, 0.12);
                border: none;
                border-radius: 8px;
                cursor: pointer;
                transition: background 0.15s ease, color 0.15s ease;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }

            .obs-scene-item:hover {
                background: rgba(0, 0, 0, 0.18);
            }

            .obs-scene-item.active {
                background: rgba(0, 0, 0, 0.18);
                color: rgba(255, 255, 255, 0.95);
                font-weight: 600;
            }

            .obs-scene-item.active::after {
                content: '●';
                color: rgba(210, 190, 255, 0.95);
                font-size: 12px;
                animation: pulse 2s infinite;
            }

            @keyframes pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.5; }
            }

            .obs-scene-name {
                flex: 1;
                font-size: 13px;
            }

            /* Скроллбар для сцен */
            .obs-scenes-container::-webkit-scrollbar {
                width: 4px;
            }

            .obs-scenes-container::-webkit-scrollbar-track {
                background: transparent;
                border-radius: 4px;
            }

            .obs-scenes-container::-webkit-scrollbar-thumb {
                background: rgba(255, 255, 255, 0.18);
                border-radius: 4px;
            }

            .obs-scenes-container::-webkit-scrollbar-thumb:hover {
                background: rgba(255, 255, 255, 0.28);
            }

            /* Появление/скрытие */
            #obs-floating-panel.show {
                opacity: 1;
            }

            #obs-floating-panel.hide {
                opacity: 0;
                pointer-events: none;
            }

            /* Resize Handle */
            .obs-resize-handle {
                position: absolute;
                bottom: 0;
                right: 0;
                width: 16px;
                height: 16px;
                background: rgba(255, 255, 255, 0.06);
                border-radius: 0 0 10px 0;
                cursor: se-resize;
                z-index: 10;
                opacity: 0.35;
                transition: opacity 0.15s ease, background 0.15s ease;
            }

            #obs-floating-panel:hover .obs-resize-handle {
                opacity: 0.8;
            }

            .obs-resize-handle:hover {
                background: rgba(255, 255, 255, 0.1);
            }

            .obs-resize-handle::before {
                content: '';
                position: absolute;
                bottom: 2px;
                right: 2px;
                width: 0;
                height: 0;
                border-style: solid;
                border-width: 0 0 10px 10px;
                border-color: transparent transparent rgba(255, 255, 255, 0.25) transparent;
            }

            .obs-resize-handle::after {
                content: '';
                position: absolute;
                bottom: 6px;
                right: 6px;
                width: 0;
                height: 0;
                border-style: solid;
                border-width: 0 0 6px 6px;
                border-color: transparent transparent rgba(255, 255, 255, 0.18) transparent;
            }
        `;

        document.head.appendChild(styles);
    }

    setupEventHandlers() {
        if (!this.panel) return;

        const header = this.panel.querySelector('.obs-panel-header');
        const minimizeBtn = this.panel.querySelector('.obs-panel-minimize');
        const closeBtn = this.panel.querySelector('.obs-panel-close');
        const resizeHandle = this.panel.querySelector('.obs-resize-handle');

        // Перетаскивание панели
        header.addEventListener('mousedown', (e) => {
            if (e.target === minimizeBtn || e.target === closeBtn) return;

            this.isDragging = true;
            this.dragStartX = e.clientX;
            this.dragStartY = e.clientY;

            const rect = this.panel.getBoundingClientRect();
            this.panelStartX = rect.left;
            this.panelStartY = rect.top;

            this.panel.classList.add('dragging');

            document.addEventListener('mousemove', this.handleDrag.bind(this));
            document.addEventListener('mouseup', this.handleDragEnd.bind(this));
        });

        // Изменение размера панели
        if (resizeHandle) {
            resizeHandle.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();

                this.isResizing = true;
                this.resizeStartX = e.clientX;
                this.resizeStartY = e.clientY;

                const rect = this.panel.getBoundingClientRect();
                this.startWidth = rect.width;
                this.startHeight = rect.height;

                this.panel.classList.add('resizing');

                document.addEventListener('mousemove', this.handleResize.bind(this));
                document.addEventListener('mouseup', this.handleResizeEnd.bind(this));
            });
        }

        // Кнопка свернуть
        minimizeBtn.addEventListener('click', () => {
            this.panel.classList.toggle('minimized');
        });

        // Кнопка закрыть
        closeBtn.addEventListener('click', () => {
            console.log('Close button clicked');
            this.hide();
            // Также отключаем настройку плавающей панели
            chrome.storage.sync.set({ obs_floating_panel_enabled: false });
        });
    }

    handleResize(e) {
        if (!this.isResizing) return;

        const deltaX = e.clientX - this.resizeStartX;
        const deltaY = e.clientY - this.resizeStartY;

        let newWidth = this.startWidth + deltaX;
        let newHeight = this.startHeight + deltaY;

        newWidth = Math.max(this.minWidth, Math.min(newWidth, this.maxWidth));
        newHeight = Math.max(this.minHeight, Math.min(newHeight, this.maxHeight));

        const rect = this.panel.getBoundingClientRect();
        const maxWidth = window.innerWidth - rect.left - 20;
        const maxHeight = window.innerHeight - rect.top - 20;

        newWidth = Math.min(newWidth, maxWidth);
        newHeight = Math.min(newHeight, maxHeight);

        this.panel.style.width = `${newWidth}px`;
        this.panel.style.height = `${newHeight}px`;
    }

    handleResizeEnd() {
        if (!this.isResizing) return;

        this.isResizing = false;
        this.panel.classList.remove('resizing');

        document.removeEventListener('mousemove', this.handleResize);
        document.removeEventListener('mouseup', this.handleResizeEnd);

        this.saveSize();
    }

    handleDrag(e) {
        if (!this.isDragging) return;

        const deltaX = e.clientX - this.dragStartX;
        const deltaY = e.clientY - this.dragStartY;

        const newX = this.panelStartX + deltaX;
        const newY = this.panelStartY + deltaY;

        // Ограничиваем перемещение границами окна
        const maxX = window.innerWidth - this.panel.offsetWidth;
        const maxY = window.innerHeight - this.panel.offsetHeight;

        const clampedX = Math.max(0, Math.min(newX, maxX));
        const clampedY = Math.max(0, Math.min(newY, maxY));

        this.panel.style.left = `${clampedX}px`;
        this.panel.style.top = `${clampedY}px`;
        this.panel.style.right = 'auto';
    }

    handleDragEnd() {
        if (!this.isDragging) return;

        this.isDragging = false;
        this.panel.classList.remove('dragging');

        document.removeEventListener('mousemove', this.handleDrag);
        document.removeEventListener('mouseup', this.handleDragEnd);

        // Сохраняем позицию
        this.savePosition();
    }

    savePosition() {
        if (!this.panel) return;

        const rect = this.panel.getBoundingClientRect();
        localStorage.setItem('obs-panel-position', JSON.stringify({
            left: rect.left,
            top: rect.top
        }));
    }

    loadPosition() {
        if (!this.panel) return;

        try {
            const position = JSON.parse(localStorage.getItem('obs-panel-position'));
            if (position) {
                this.panel.style.left = `${position.left}px`;
                this.panel.style.top = `${position.top}px`;
                this.panel.style.right = 'auto';
            }
        } catch (error) {
            console.error('Failed to load panel position:', error);
        }
    }

    saveSize() {
        if (!this.panel) return;

        const rect = this.panel.getBoundingClientRect();
        localStorage.setItem('obs-panel-size', JSON.stringify({
            width: rect.width,
            height: rect.height
        }));
    }

    loadSize() {
        if (!this.panel) return;

        try {
            const size = JSON.parse(localStorage.getItem('obs-panel-size'));
            if (size) {
                const width = Math.max(this.minWidth, Math.min(size.width, this.maxWidth));
                const height = Math.max(this.minHeight, Math.min(size.height, this.maxHeight));

                this.panel.style.width = `${width}px`;
                this.panel.style.height = `${height}px`;
            }
        } catch (error) {
            console.error('Failed to load panel size:', error);
        }
    }

    async requestOBSStatus() {
        try {
            // Запрашиваем статус OBS через background
            chrome.runtime.sendMessage({
                type: 'obs_command',
                command: 'get_status'
            }, (response) => {
                if (response && response.success) {
                    const status = response.data;

                    if (status.connected) {
                        this.updateConnectionStatus('Подключено', 'connected');
                        this.scenes = status.scenes || [];
                        this.currentScene = status.currentScene;
                        this.updateScenesDisplay();
                    } else {
                        this.updateConnectionStatus('Не подключено', 'error');
                        this.scenes = [];
                        this.currentScene = null;
                        this.updateScenesDisplay();
                    }
                } else {
                    this.updateConnectionStatus('Ошибка подключения', 'error');
                }
            });
        } catch (error) {
            console.error('Failed to request OBS status:', error);
            this.updateConnectionStatus('Ошибка', 'error');
        }
    }

    updateConnectionStatus(text, status = 'default') {
        if (!this.panel) {
            console.log('Panel not created, skipping connection status update');
            return;
        }

        const statusElement = this.panel.querySelector('.obs-connection-status');
        if (statusElement) {
            statusElement.textContent = text;
            statusElement.className = `obs-connection-status ${status}`;
        } else {
            console.log('Connection status element not found');
        }
    }

    updateScenesDisplay() {
        if (!this.panel) {
            console.log('Panel not created, skipping scenes display update');
            return;
        }

        const container = this.panel.querySelector('.obs-scenes-container');
        if (!container) {
            console.log('Scenes container not found');
            return;
        }

        if (!this.scenes || this.scenes.length === 0) {
            container.innerHTML = '<div class="obs-no-scenes">Нет доступных сцен</div>';
            return;
        }

        container.innerHTML = this.scenes.map(scene => {
            const isActive = scene.sceneName === this.currentScene;
            return `
                <div class="obs-scene-item ${isActive ? 'active' : ''}" data-scene="${scene.sceneName}">
                    <span class="obs-scene-name">${scene.sceneName}</span>
                </div>
            `;
        }).join('');

        // Добавляем обработчики клика для переключения сцен
        container.querySelectorAll('.obs-scene-item').forEach(item => {
            item.addEventListener('click', async () => {
                const sceneName = item.dataset.scene;
                await this.switchScene(sceneName);
            });
        });
    }

    updateCurrentSceneHighlight() {
        if (!this.panel) return;

        const sceneItems = this.panel.querySelectorAll('.obs-scene-item');
        sceneItems.forEach(item => {
            const isActive = item.dataset.scene === this.currentScene;
            item.classList.toggle('active', isActive);
        });

        console.log('Updated current scene highlight for:', this.currentScene);
    }

    async switchScene(sceneName) {
        return new Promise((resolve, reject) => {
            try {
                chrome.runtime.sendMessage({
                    type: 'obs_command',
                    command: 'set_scene',
                    data: { sceneName }
                }, (response) => {
                    if (response && response.success) {
                        // currentScene уже обновлен в autoSwitchScene
                        this.updateCurrentSceneHighlight();
                        resolve(response);
                    } else {
                        console.error('Failed to switch scene:', response?.error);
                        reject(response?.error || 'Unknown error');
                    }
                });
            } catch (error) {
                console.error('Failed to switch scene:', error);
                reject(error);
            }
        });
    }

    show() {
        if (!this.hasActiveGameInterface()) {
            this.isGameUiVisible = false;
            return;
        }

        if (!this.panel) {
            this.createPanel();
        }

        // Убеждаемся что панель видима
        this.panel.style.display = 'flex';
        this.panel.classList.add('show');
        this.panel.classList.remove('hide');
        this.isVisible = true;

        console.log('Showing floating panel');

        // Обновляем статус при показе
        this.requestOBSStatus();

        // Запускаем наблюдение за DOM если включен автоматический режим
        if (this.autoModeEnabled) {
            this.startDOMMonitoring();
        }
    }

    hide() {
        if (!this.panel) return;

        console.log('Hiding floating panel');

        this.panel.classList.add('hide');
        this.panel.classList.remove('show');

        setTimeout(() => {
            if (this.panel) {
                this.panel.style.display = 'none';
            }
        }, 300);

        this.isVisible = false;
    }

    toggle() {
        console.log('Toggling panel, current state - isVisible:', this.isVisible, 'panel exists:', !!this.panel);

        if (this.isVisible) {
            this.hide();
        } else {
            this.show();
        }
    }

    destroy() {
        if (this.panel) {
            this.panel.remove();
            this.panel = null;
        }

        const styles = document.getElementById('obs-floating-panel-styles');
        if (styles) {
            styles.remove();
        }

        // Останавливаем наблюдение за DOM
        if (this.domObserver) {
            this.domObserver.disconnect();
            this.domObserver = null;
        }

        if (this.pendingRoleVisibilityTimer) {
            clearTimeout(this.pendingRoleVisibilityTimer);
            this.pendingRoleVisibilityTimer = null;
        }

        if (this.gameUiObserver) {
            this.gameUiObserver.disconnect();
            this.gameUiObserver = null;
        }

        if (this.gameUiCheckDebounceTimer) {
            clearTimeout(this.gameUiCheckDebounceTimer);
            this.gameUiCheckDebounceTimer = null;
        }

        this.isVisible = false;
    }

    getRoleVisibilityTargets() {
        const selectors = [
            '.player__role.role.role.my-role',
            '.my-role .player__role.role.role',
            '.player__role.my-role',
            '.my-role',
            '.my-role svg',
            '.my-role .tooltip'
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

    applyRoleVisibility(isVisible) {
        const directHandler = isVisible ? window.showOwnRole : window.hideOwnRole;
        if (typeof directHandler === 'function') {
            const handled = directHandler();
            if (handled) {
                this.lastAppliedRoleVisibility = isVisible ? 'visible' : 'hidden';
                console.log(`Role visibility applied via window handler: ${this.lastAppliedRoleVisibility}`);
                return true;
            }
        }

        const targets = this.getRoleVisibilityTargets();

        if (targets.length === 0) {
            console.log('Role visibility targets not found, skipping role update');
            return false;
        }

        targets.forEach((element) => {
            if (!this.roleVisibilityState.has(element)) {
                this.roleVisibilityState.set(element, {
                    visibility: element.style.visibility,
                    opacity: element.style.opacity,
                    pointerEvents: element.style.pointerEvents
                });
            }

            const originalState = this.roleVisibilityState.get(element);
            if (isVisible) {
                element.style.visibility = originalState.visibility;
                element.style.opacity = originalState.opacity;
                element.style.pointerEvents = originalState.pointerEvents;
            } else {
                element.style.visibility = 'hidden';
                element.style.opacity = '0';
                element.style.pointerEvents = 'none';
            }
        });

        this.lastAppliedRoleVisibility = isVisible ? 'visible' : 'hidden';
        console.log(`Role visibility applied: ${this.lastAppliedRoleVisibility}`);
        return true;
    }

    scheduleRoleVisibility(timeOfDay, attempt = 0) {
        const shouldShowRoles = timeOfDay === 'night';
        const targetVisibility = shouldShowRoles ? 'visible' : 'hidden';

        if (this.pendingRoleVisibilityTimer) {
            clearTimeout(this.pendingRoleVisibilityTimer);
            this.pendingRoleVisibilityTimer = null;
        }

        if (this.lastAppliedRoleVisibility === targetVisibility) {
            console.log('Role visibility already set to', targetVisibility);
            return;
        }

        const delayMs = shouldShowRoles
            ? (attempt === 0 ? this.roleVisibilityDelayMs : 500)
            : (attempt === 0 ? 0 : 250);
        console.log(`Scheduling role visibility change to ${targetVisibility} in ${delayMs}ms`);
        this.pendingRoleVisibilityTimer = setTimeout(() => {
            this.pendingRoleVisibilityTimer = null;
            const applied = this.applyRoleVisibility(shouldShowRoles);
            if (!applied && attempt < 5) {
                this.scheduleRoleVisibility(timeOfDay, attempt + 1);
            }
        }, delayMs);
    }

    async hideRoleBeforeDaySceneSwitch() {
        if (this.pendingRoleVisibilityTimer) {
            clearTimeout(this.pendingRoleVisibilityTimer);
            this.pendingRoleVisibilityTimer = null;
        }

        this.applyRoleVisibility(false);
        this.lastAppliedRoleVisibility = 'hidden';

        // Give DOM a moment to paint the hidden state before OBS scene switching.
        await new Promise((resolve) => setTimeout(resolve, 30));
    }

    /**
     * Логирует текущую стадию игры для отладки
     */
    logCurrentGameStage() {
        try {
            // Получаем текущую стадию
            const currentStage = document.querySelector('.substage.current');
            const nextStage = document.querySelector('.substage.next');
            const allStages = document.querySelectorAll('.stage, .substage');

            let currentStageText = 'не найдена';
            let nextStageText = 'не найдена';

            if (currentStage) {
                currentStageText = currentStage.textContent?.toLowerCase().trim() || 'пустая';
            }

            if (nextStage) {
                nextStageText = nextStage.textContent?.toLowerCase().trim() || 'пустая';
            }

            // Логируем все найденные стадии
            const allStagesText = Array.from(allStages).map(stage =>
                `${stage.className}: "${stage.textContent?.trim() || 'пустая'}"`
            ).join(', ');

            console.log('🎯 Текущая стадия игры:', {
                current: currentStageText,
                next: nextStageText,
                allStages: allStagesText,
                currentScene: this.currentScene,
                autoMode: this.autoModeEnabled
            });
        } catch (error) {
            console.error('Ошибка при логировании стадии игры:', error);
        }
    }

    /**
     * Определяет время суток на основе DOM элементов страницы игры
     */
    detectTimeOfDay() {
        try {
            // Логируем текущую стадию игры для отладки
            this.logCurrentGameStage();

            // 1. Проверяем наличие надписи "Промах" - всегда день
            const missElement = document.querySelector('.ended__title');
            if (missElement && missElement.textContent.includes('Промах')) {
                console.log('Detected MISS - forcing DAY scene');
                return 'day';
            }

            // 2. Ищем элементы "До смены этапа"
            const stageChangeElements = document.querySelectorAll('*');
            let stageChangeText = '';

            stageChangeElements.forEach(element => {
                const text = element.textContent?.toLowerCase() || '';
                if (text.includes('до смены этапа')) {
                    stageChangeText = text;
                }
            });

            if (stageChangeText) {
                // Нашли "До смены этапа" - проверяем следующий этап
                const nextStage = document.querySelector('.substage.next');
                if (nextStage) {
                    const nextStageText = nextStage.textContent?.toLowerCase() || '';

                    console.log('Found "До смены этапа", next stage:', nextStageText);

                    // ДЕНЬ для следующих этапов
                    const dayStages = [
                        'день | речь игрока',
                        'голосование',
                        'доп. речь',
                        'прощальная минута',
                        'лучший ход',
                        'промах'
                    ];

                    for (const dayStage of dayStages) {
                        if (nextStageText.includes(dayStage)) {
                            console.log('Detected DAY via next stage:', dayStage);
                            return 'day';
                        }
                    }

                    // НОЧЬ для следующих этапов ТОЛЬКО при наличии "ДО СМЕНЫ ЭТАПА"
                    const nightStages = [
                        'ночь',
                        'знакомство мафии'
                    ];

                    for (const nightStage of nightStages) {
                        if (nextStageText.includes(nightStage)) {
                            console.log('Detected NIGHT via next stage:', nightStage);
                            return 'night';
                        }
                    }
                }

                // Дополнительная проверка: если есть "До смены этапа" с таймером (4 сек, 3 сек и т.д.)
                // и субстадия содержит "ночь" - переключаем на ночь
                if (stageChangeText.match(/до смены этапа \d+ сек/)) {
                    const currentSubstage = document.querySelector('.substage.current');
                    if (currentSubstage) {
                        const currentText = currentSubstage.textContent?.toLowerCase() || '';
                        if (currentText.includes('ночь')) {
                            console.log('Detected NIGHT via "До смены этапа" with timer and night substage');
                            return 'night';
                        }
                    }
                }
            }

            // Проверяем текущий субтекст - если есть просто "Ночь" без "ДО СМЕНЫ ЭТАПА", игнорируем
            const currentSubstage = document.querySelector('.substage.current');
            if (currentSubstage) {
                const currentText = currentSubstage.textContent?.toLowerCase() || '';
                // Если субтекст содержит только "ночь" без других признаков ночи - оставляем день
                if (currentText.trim() === 'ночь') {
                    const fallbackTime = this.currentTimeOfDay || 'day';
                    console.log('Found isolated "Ночь" in subtext without "ДО СМЕНЫ ЭТАПА" - keeping', fallbackTime.toUpperCase());
                    return fallbackTime;
                }
            }

            // 3. Специальная обработка стадии "Голосование" с субстадией "Итоги подъема"
            const votingStage = document.querySelector('.stage, .substage');
            const votingResultsSubstage = document.querySelector('.substage.current, .substage');
            if (votingStage && votingResultsSubstage) {
                const votingText = votingStage.textContent?.toLowerCase() || '';
                const substageText = votingResultsSubstage.textContent?.toLowerCase() || '';

                // Голосование с итогами подъема - всегда ДЕНЬ
                if ((votingText.includes('голосование') || votingText.includes('итоги подъема')) &&
                    substageText.includes('итоги подъема')) {
                    console.log('Detected DAY: Голосование с итогами подъема');
                    return 'day';
                }
            }

            // 5. Ищем текущую стадию игры (без "До смены этапа")
            const currentStage = document.querySelector('.substage.current');
            if (currentStage) {
                const stageText = currentStage.textContent?.toLowerCase() || '';

                // НОЧЬ для раздачи карт (даже без "До смены этапа")
                if (stageText.includes('раздача карт')) {
                    console.log('Detected NIGHT: Раздача карт');
                    return 'night';
                }

                // Всегда НОЧЬ для основных ночных этапов
                const nightStages = [
                    'ночь | знакомство мафии',
                    'ночь | ход мафии',
                    'ночь | проверки'
                ];

                for (const nightStage of nightStages) {
                    if (stageText.includes(nightStage)) {
                        console.log('Detected NIGHT stage:', nightStage);
                        return 'night';
                    }
                }

                // Всегда ДЕНЬ для дневных стадий
                if (stageText.includes('день | речь игрока')) {
                    console.log('Detected DAY stage: День | Речь игрока');
                    return 'day';
                }
            }

            // 6. Ищем все стадии в игре для fallback
            const allStages = document.querySelectorAll('.stage, .substage');
            let hasAnyNightStage = false;
            let hasAnyDayStage = false;

            allStages.forEach(stage => {
                const stageText = stage.textContent?.toLowerCase() || '';
                // Проверяем, является ли это субстадией с просто "ночь"
                const isSubstage = stage.classList.contains('substage');
                const isIsolatedNight = isSubstage && stageText.trim() === 'ночь';

                if (stageText.includes('ночь') && !stageText.includes('день') && !isIsolatedNight) {
                    hasAnyNightStage = true;
                }
                if (stageText.includes('день') || stageText.includes('итоги подъема')) {
                    hasAnyDayStage = true;
                }
            });

            // 7. Определяем по приоритету
            if (hasAnyNightStage) {
                console.log('Detected NIGHT via any night stage found');
                return 'night';
            }

            if (hasAnyDayStage) {
                console.log('Detected DAY via any day stage found');
                return 'day';
            }

            // 7. По умолчанию день для всех остальных случаев
            const fallbackTime = this.currentTimeOfDay || 'day';
            console.log('No specific stage detected - keeping', fallbackTime.toUpperCase());
            return fallbackTime;

        } catch (error) {
            console.error('Error detecting time of day:', error);
            return this.currentTimeOfDay || 'day';
        }
    }

    requestTimeOfDayCheck() {
        if (!this.autoModeEnabled) return;

        if (this.timeOfDayCheckDebounceTimer) {
            this.timeOfDayCheckQueued = true;
            return;
        }

        this.timeOfDayCheckDebounceTimer = setTimeout(() => {
            this.timeOfDayCheckDebounceTimer = null;
            this.evaluateTimeOfDay();
            if (this.timeOfDayCheckQueued) {
                this.timeOfDayCheckQueued = false;
                this.requestTimeOfDayCheck();
            }
        }, 150);
    }

    evaluateTimeOfDay() {
        const newTimeOfDay = this.detectTimeOfDay();
        const previousTimeOfDay = this.currentTimeOfDay;

        console.log('📊 Результат определения времени:', newTimeOfDay, '(предыдущее:', previousTimeOfDay, ')');

        if (newTimeOfDay === previousTimeOfDay) {
            this.pendingTimeOfDay = null;
            if (this.pendingTimeOfDayConfirmTimer) {
                clearTimeout(this.pendingTimeOfDayConfirmTimer);
                this.pendingTimeOfDayConfirmTimer = null;
            }
            console.log('✅ Время суток не изменилось:', newTimeOfDay);
            return;
        }

        console.log('🕒 Обнаружено потенциальное изменение времени суток с', previousTimeOfDay, 'на', newTimeOfDay);

        if (this.pendingTimeOfDay !== newTimeOfDay) {
            this.pendingTimeOfDay = newTimeOfDay;

            if (this.pendingTimeOfDayConfirmTimer) {
                clearTimeout(this.pendingTimeOfDayConfirmTimer);
            }

            this.pendingTimeOfDayConfirmTimer = setTimeout(async () => {
                this.pendingTimeOfDayConfirmTimer = null;
                if (this.pendingTimeOfDay !== newTimeOfDay) return;

                const confirmedTimeOfDay = this.detectTimeOfDay();
                if (confirmedTimeOfDay === newTimeOfDay && confirmedTimeOfDay !== this.currentTimeOfDay) {
                    console.log('🌅 Подтверждено изменение времени суток с', this.currentTimeOfDay, 'на', confirmedTimeOfDay);
                    this.currentTimeOfDay = confirmedTimeOfDay;
                    this.pendingTimeOfDay = null;
                    if (confirmedTimeOfDay === 'day') {
                        await this.hideRoleBeforeDaySceneSwitch();
                    }
                    this.scheduleRoleVisibility(confirmedTimeOfDay);
                    this.savePersistedAutoState();
                    await this.autoSwitchScene(confirmedTimeOfDay);
                } else {
                    console.log('🛑 Изменение времени суток не подтверждено (ожидали:', newTimeOfDay, ', получили:', confirmedTimeOfDay, ')');
                    this.pendingTimeOfDay = null;
                }
            }, 350);
        }
    }

    /**
     * Автоматически переключает сцену в зависимости от времени суток
     */
    async autoSwitchScene(timeOfDay) {
        if (!this.autoModeEnabled) {
            console.log('⏸️ Auto mode disabled, skipping scene switch');
            return;
        }

        const targetScene = timeOfDay === 'day' ? this.dayScene : this.nightScene;

        if (!targetScene) {
            console.log('⚠️ No target scene configured for', timeOfDay, '(dayScene:', this.dayScene, ', nightScene:', this.nightScene, ')');
            return;
        }

        if (this.currentScene === targetScene) {
            console.log('✅ Scene already set to', targetScene, '(timeOfDay:', timeOfDay, ')');
            return;
        }

        console.log('🎬 Автоматическое переключение на', timeOfDay, 'сцену:', targetScene, '(предыдущая:', this.currentScene, ')');

        // Обновляем currentScene сразу для корректного логирования
        this.currentScene = targetScene;

        try {
            await this.switchScene(targetScene);
            console.log('✅ Успешно переключено на сцену:', targetScene, '(время суток:', timeOfDay, ')');
        } catch (error) {
            console.error('❌ Ошибка при автоматическом переключении сцены:', error, '(целевая сцена:', targetScene, ')');
        }
    }

    /**
     * Запускает наблюдение за изменениями в DOM для автоматического переключения
     */
    startDOMMonitoring() {
        if (!this.autoModeEnabled) {
            console.log('Auto mode disabled, not starting DOM monitoring');
            return;
        }

        console.log('🎯 Starting DOM monitoring for automatic scene switching...');

        // Останавливаем предыдущее наблюдение
        if (this.domObserver) {
            this.domObserver.disconnect();
        }

        this.domObserver = new MutationObserver((mutations) => {
            let shouldCheckTime = false;

            mutations.forEach((mutation) => {
                // Проверяем изменения в DOM
                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    shouldCheckTime = true;
                } else if (mutation.type === 'attributes' &&
                          (mutation.attributeName === 'class' || mutation.attributeName === 'style')) {
                    shouldCheckTime = true;
                } else if (mutation.type === 'characterData') {
                    // Проверяем изменения текста в элементах стадий
                    let element = mutation.target;
                    while (element && element !== document.body) {
                        if (element.classList &&
                           (element.classList.contains('stage') ||
                            element.classList.contains('substage') ||
                            element.classList.contains('ended__title'))) {
                            shouldCheckTime = true;
                            break;
                        }
                        element = element.parentElement;
                    }
                }
            });

            if (shouldCheckTime) {
                console.log('🔍 Обнаружено изменение в DOM, проверяем время суток...');
                this.requestTimeOfDayCheck();
            }
        });

        // Начинаем наблюдение за изменениями в DOM
        this.domObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'id'],
            characterData: true // Наблюдаем за изменениями текста
        });

        console.log('✅ DOM monitoring started for auto scene switching');

        // Выполняем начальную проверку времени суток
        setTimeout(() => {
            console.log('🔍 Performing initial time detection...');
            this.requestTimeOfDayCheck();
        }, 1000);
    }

    /**
     * Останавливает наблюдение за DOM
     */
    stopDOMMonitoring() {
        if (this.domObserver) {
            this.domObserver.disconnect();
            this.domObserver = null;
            console.log('DOM monitoring stopped');
        }

        if (this.timeOfDayCheckDebounceTimer) {
            clearTimeout(this.timeOfDayCheckDebounceTimer);
            this.timeOfDayCheckDebounceTimer = null;
        }

        if (this.pendingTimeOfDayConfirmTimer) {
            clearTimeout(this.pendingTimeOfDayConfirmTimer);
            this.pendingTimeOfDayConfirmTimer = null;
        }

        this.timeOfDayCheckQueued = false;
        this.pendingTimeOfDay = null;
    }

    /**
     * Запускает периодическое отслеживание активной сцены OBS
     */
    startSceneTracking() {
        if (this.sceneTrackingInterval) {
            clearInterval(this.sceneTrackingInterval);
        }

        this.sceneTrackingInterval = setInterval(async () => {
            try {
                const activeScene = await this.getActiveScene();
                if (activeScene && activeScene !== this.lastTrackedScene) {
                    console.log('📺 Изменение активной сцены OBS:', activeScene, '(предыдущая:', this.lastTrackedScene, ')');
                    this.lastTrackedScene = activeScene;
                    // Синхронизируем currentScene с реальной активной сценой OBS
                    if (this.currentScene !== activeScene) {
                        console.log('🔄 Синхронизация currentScene с OBS:', activeScene);
                        this.currentScene = activeScene;
                        this.updateCurrentSceneHighlight();
                    }
                }
            } catch (error) {
                console.error('Ошибка при отслеживании сцены OBS:', error);
            }
        }, 2000); // Проверяем каждые 2 секунды

        console.log('👁️ Запущено отслеживание активной сцены OBS');
    }

    /**
     * Останавливает отслеживание активной сцены OBS
     */
    stopSceneTracking() {
        if (this.sceneTrackingInterval) {
            clearInterval(this.sceneTrackingInterval);
            this.sceneTrackingInterval = null;
            console.log('👁️ Остановлено отслеживание активной сцены OBS');
        }
    }

    /**
     * Принудительно проверяет время суток и переключает сцену если нужно
     */
    async forceTimeCheck() {
        console.log('🔄 Принудительная проверка времени суток...');
        const timeOfDay = this.detectTimeOfDay();
        const previousTimeOfDay = this.currentTimeOfDay;

        if (timeOfDay !== previousTimeOfDay) {
            console.log('⚡ Принудительное изменение времени с', previousTimeOfDay, 'на', timeOfDay);
            this.currentTimeOfDay = timeOfDay;
            this.pendingTimeOfDay = null;
            if (this.pendingTimeOfDayConfirmTimer) {
                clearTimeout(this.pendingTimeOfDayConfirmTimer);
                this.pendingTimeOfDayConfirmTimer = null;
            }
            if (timeOfDay === 'day') {
                await this.hideRoleBeforeDaySceneSwitch();
            }
            this.scheduleRoleVisibility(timeOfDay);
            this.savePersistedAutoState();
            await this.autoSwitchScene(timeOfDay);
        } else {
            console.log('✅ Принудительная проверка: время суток не изменилось (', timeOfDay, ')');
        }

        return timeOfDay;
    }

    /**
     * Автоматически запускает определение времени суток при загрузке
     */
    startAutoTimeDetection() {
        console.log('🚀 Starting automatic time detection...');

        // Запускаем отслеживание активной сцены
        this.startSceneTracking();

        // Запускаем определение времени суток сразу
        setTimeout(() => {
            this.requestTimeOfDayCheck();
        }, 1000);

        // Запускаем мониторинг DOM если включен авторежим
        if (this.autoModeEnabled) {
            this.startDOMMonitoring();
        }
    }
}

// Инициализация панели при загрузке страницы
let obsFloatingPanel = null;

// Ждем полной загрузки страницы
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFloatingPanel);
} else {
    initFloatingPanel();
}

function initFloatingPanel() {
    // Проверяем, что мы на правильной странице
    if (window.location.hostname.includes('polemicagame.com')) {
        obsFloatingPanel = new FloatingOBSPanel();
        console.log('OBS Floating Panel initialized');
    }
}

// Экспорт для возможного использования извне
window.obsFloatingPanel = obsFloatingPanel;

// Добавляем функцию для отладки в глобальную область видимости
window.forceTimeCheck = () => {
    if (obsFloatingPanel && obsFloatingPanel.forceTimeCheck) {
        return obsFloatingPanel.forceTimeCheck();
    } else {
        console.error('OBS Floating Panel не инициализирован');
    }
};

// Тестирование стадии голосования
window.testVotingStage = () => {
    console.log('🧪 Тестирование стадии голосования...');
    const stages = document.querySelectorAll('.stage, .substage');
    stages.forEach(stage => {
        const text = stage.textContent?.toLowerCase() || '';
        if (text.includes('итоги подъема') || text.includes('голосование')) {
            console.log('📊 Найдена стадия голосования:', text);
        }
    });
};
