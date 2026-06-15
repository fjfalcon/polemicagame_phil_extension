/**
 * Плавающая панель Twitch чата для страницы игры
 */

class FloatingTwitchChatPanel {
    constructor() {
        this.panel = null;
        this.isVisible = false;
        this.isDragging = false;
        this.dragStartX = 0;
        this.dragStartY = 0;
        this.panelStartX = 0;
        this.panelStartY = 0;
        this.isEnabled = false;
        this.channelName = '';
        this.socket = null;
        this.isConnected = false;
        this.messages = [];
        this.maxMessages = 100;
        
        // Resize functionality
        this.isResizing = false;
        this.resizeStartX = 0;
        this.resizeStartY = 0;
        this.startWidth = 0;
        this.startHeight = 0;
        this.minWidth = 250;
        this.minHeight = 120;
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
            if (this.channelName) {
                this.connectToTwitch();
            }
        }

        this.startGameUiMonitoring();
        this.syncPanelVisibilityWithGameState();

        // Слушаем сообщения от popup
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            console.log('📩 Twitch panel received runtime message:', message);
            this.handleMessage(message, sender, sendResponse);
            return true;
        });

        // Слушаем изменения в настройках
        chrome.storage.onChanged.addListener((changes, namespace) => {
            if (changes.twitch_chat_enabled) {
                this.isEnabled = changes.twitch_chat_enabled.newValue;
                if (this.isEnabled) {
                    this.show();
                } else {
                    this.hide();
                    this.disconnect();
                }
            }
            
            if (changes.twitch_channel_name) {
                this.channelName = changes.twitch_channel_name.newValue;
                if (this.isEnabled && this.channelName && this.hasActiveGameInterface()) {
                    this.connectToTwitch();
                }
            }
        });
    }

    async loadSettings() {
        try {
            const settings = await chrome.storage.sync.get(['twitch_chat_enabled', 'twitch_channel_name']);
            this.isEnabled = settings.twitch_chat_enabled || false;
            this.channelName = settings.twitch_channel_name || '';
        } catch (error) {
            console.error('Failed to load Twitch chat settings:', error);
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

    handleMessage(message, sender, sendResponse) {
        console.log('Twitch chat panel received message:', message.type, message);
        
        switch (message.type) {
            case 'twitch_panel_toggle':
                this.toggle();
                if (sendResponse) sendResponse({ success: true });
                break;
                
            case 'twitch_panel_show':
                this.show();
                if (sendResponse) sendResponse({ success: true });
                break;
                
            case 'twitch_panel_hide':
                this.hide();
                if (sendResponse) sendResponse({ success: true });
                break;
                
            case 'twitch_connect':
                if (message.data && message.data.channel) {
                    this.channelName = message.data.channel;
                    this.connectToTwitch();
                }
                if (sendResponse) sendResponse({ success: true });
                break;
                
            case 'twitch_disconnect':
                this.disconnect();
                if (sendResponse) sendResponse({ success: true });
                break;
        }
        
        return true;
    }

    connectToTwitch() {
        if (!this.channelName) {
            console.log('No Twitch channel specified');
            return;
        }

        if (this.socket) {
            this.socket.close();
        }

        console.log('Connecting to Twitch chat for channel:', this.channelName);

        try {
            this.socket = new WebSocket('wss://irc-ws.chat.twitch.tv:443');

            this.socket.onopen = () => {
                console.log('Connected to Twitch IRC WebSocket');
                
                // Аутентификация как анонимный пользователь
                this.socket.send('PASS SCHMOOPIIE');
                this.socket.send('NICK justinfan12345');
                this.socket.send(`JOIN #${this.channelName.toLowerCase()}`);
                
                this.isConnected = true;
                this.addSystemMessage('Подключились к чату');
            };

            this.socket.onmessage = (event) => {
                this.handleTwitchMessage(event.data);
            };

            this.socket.onclose = () => {
                console.log('Twitch chat disconnected');
                this.isConnected = false;
                this.addSystemMessage('Отключились от чата');
            };

            this.socket.onerror = (error) => {
                console.error('Twitch WebSocket error:', error);
                this.addSystemMessage('Ошибка подключения к чату');
            };

        } catch (error) {
            console.error('Failed to connect to Twitch:', error);
        }
    }

    disconnect() {
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
        this.isConnected = false;
    }

    handleTwitchMessage(data) {
        const lines = data.split('\r\n');
        
        lines.forEach(line => {
            if (!line) return;
            
            console.log('Twitch IRC:', line);
            
            // Отвечаем на PING сообщения
            if (line.startsWith('PING')) {
                this.socket.send(line.replace('PING', 'PONG'));
                return;
            }
            
            // Парсим сообщения чата
            if (line.includes('PRIVMSG')) {
                this.parsePrivMsg(line);
            }
        });
    }

    parsePrivMsg(line) {
        try {
            // Парсим IRC сообщение формата:
            // :username!username@username.tmi.twitch.tv PRIVMSG #channel :message
            const match = line.match(/:([^!]+)![^@]+@[^\s]+ PRIVMSG #[^\s]+ :(.+)/);
            
            if (match) {
                const username = match[1];
                const message = match[2];
                
                this.addChatMessage(username, message);
            }
        } catch (error) {
            console.error('Failed to parse Twitch message:', error);
        }
    }

    addChatMessage(username, message) {
        const messageObj = {
            id: Date.now() + Math.random(),
            username: username,
            message: message,
            timestamp: new Date(),
            type: 'chat'
        };

        this.messages.push(messageObj);
        
        // Ограничиваем количество сообщений
        if (this.messages.length > this.maxMessages) {
            this.messages.shift();
        }

        this.updateChatDisplay();
    }

    addSystemMessage(message) {
        const messageObj = {
            id: Date.now() + Math.random(),
            message: message,
            timestamp: new Date(),
            type: 'system'
        };

        this.messages.push(messageObj);
        this.updateChatDisplay();
    }

    createPanel() {
        if (this.panel) return;

        // Создаем основной контейнер панели
        this.panel = document.createElement('div');
        this.panel.id = 'twitch-chat-panel';
        this.panel.innerHTML = `
            <div class="twitch-panel-header">
                <span class="twitch-panel-title">Twitch Chat</span>
                <div class="twitch-panel-controls">
                    <button class="twitch-panel-minimize" title="Свернуть">−</button>
                    <button class="twitch-panel-close" title="Закрыть">×</button>
                </div>
            </div>
            <div class="twitch-panel-content">
                <div class="twitch-chat-container">
                    <div class="twitch-chat-messages">
                        <div class="twitch-no-messages">Чат пуст</div>
                    </div>
                </div>
            </div>
            <div class="twitch-resize-handle" title="Изменить размер"></div>
        `;

        // Добавляем стили
        this.addStyles();

        // Добавляем обработчики событий
        this.setupEventHandlers();

        // Добавляем панель на страницу
        document.body.appendChild(this.panel);

        // Загружаем позицию и размер из localStorage
        this.loadPosition();
        this.loadSize();

        console.log('Twitch Chat Panel created');
    }

    addStyles() {
        if (document.getElementById('twitch-chat-panel-styles')) return;

        const styles = document.createElement('style');
        styles.id = 'twitch-chat-panel-styles';
        styles.textContent = `
            #twitch-chat-panel {
                position: fixed;
                top: 20px;
                left: 20px;
                width: 280px;
                height: 150px;
                min-width: 250px;
                min-height: 120px;
                max-width: 800px;
                max-height: 600px;
                background: linear-gradient(135deg, rgba(0, 0, 0, 0.35), rgba(147, 70, 255, 0.18) 55%, rgba(0, 0, 0, 0.25));
                border: none;
                border-radius: 10px;
                box-shadow: none;
                backdrop-filter: blur(6px);
                z-index: 99998;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                font-size: 13px;
                color: rgba(255, 255, 255, 0.92);
                user-select: none;
                transition: opacity 0.15s ease;
                transform-origin: top left;
                display: flex;
                flex-direction: column;
                resize: none; /* Отключаем браузерный resize */
            }

            #twitch-chat-panel.minimized {
                height: 28px;
                overflow: hidden;
            }

            #twitch-chat-panel.dragging {
                transition: none;
                transform: none;
            }

            #twitch-chat-panel.resizing {
                transition: none;
            }

            .twitch-panel-header {
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

            .twitch-panel-title {
                font-weight: 500;
                font-size: 12px;
                color: rgba(255, 255, 255, 0.75);
                display: flex;
                align-items: center;
                gap: 6px;
            }

            .twitch-panel-controls {
                display: flex;
                gap: 6px;
                opacity: 0;
                pointer-events: none;
                transition: opacity 0.15s ease;
            }

            #twitch-chat-panel:hover .twitch-panel-controls {
                opacity: 0.9;
                pointer-events: auto;
            }

            .twitch-panel-minimize,
            .twitch-panel-close {
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

            .twitch-panel-minimize:hover,
            .twitch-panel-close:hover {
                background: rgba(255, 255, 255, 0.08);
                color: rgba(255, 255, 255, 0.95);
            }

            .twitch-panel-content {
                padding: 8px;
                flex: 1;
                display: flex;
                flex-direction: column;
                overflow: hidden;
            }

            .twitch-chat-container {
                flex: 1;
                display: flex;
                flex-direction: column;
                overflow: hidden;
            }

            .twitch-chat-messages {
                flex: 1;
                overflow-y: auto;
                padding: 6px;
                background: rgba(0, 0, 0, 0.12);
                border-radius: 8px;
                border: none;
            }

            .twitch-no-messages {
                text-align: center;
                color: #6c757d;
                font-size: 12px;
                padding: 20px;
                font-style: italic;
            }

            .twitch-message {
                margin-bottom: 2px;
                padding: 2px 0;
                border-bottom: none;
            }

            .twitch-message:last-child {
                border-bottom: none;
                margin-bottom: 0;
            }

            .twitch-username {
                font-weight: 600;
                color: rgba(210, 190, 255, 0.95);
                font-size: 12px;
                display: inline-block;
                margin-right: 6px;
            }

            .twitch-message-text {
                color: #ffffff;
                font-size: 12px;
                word-wrap: break-word;
                line-height: 1.4;
            }

            .twitch-system-message {
                color: rgba(255, 255, 255, 0.55);
                font-size: 11px;
                font-style: italic;
                text-align: center;
                padding: 4px;
                margin: 4px 0;
            }

            .twitch-timestamp {
                color: rgba(255, 255, 255, 0.45);
                font-size: 10px;
                margin-left: 4px;
            }

            /* Скроллбар для чата */
            .twitch-chat-messages::-webkit-scrollbar {
                width: 4px;
            }

            .twitch-chat-messages::-webkit-scrollbar-track {
                background: transparent;
                border-radius: 4px;
            }

            .twitch-chat-messages::-webkit-scrollbar-thumb {
                background: rgba(255, 255, 255, 0.18);
                border-radius: 4px;
            }

            .twitch-chat-messages::-webkit-scrollbar-thumb:hover {
                background: rgba(255, 255, 255, 0.28);
            }

            /* Появление/скрытие */
            #twitch-chat-panel.show {
                opacity: 1;
            }

            #twitch-chat-panel.hide {
                opacity: 0;
                pointer-events: none;
            }

            /* Resize Handle */
            .twitch-resize-handle {
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

            #twitch-chat-panel:hover .twitch-resize-handle {
                opacity: 0.8;
            }

            .twitch-resize-handle:hover {
                background: rgba(255, 255, 255, 0.1);
            }

            .twitch-resize-handle::before {
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

            .twitch-resize-handle::after {
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
        const header = this.panel.querySelector('.twitch-panel-header');
        const minimizeBtn = this.panel.querySelector('.twitch-panel-minimize');
        const closeBtn = this.panel.querySelector('.twitch-panel-close');
        const resizeHandle = this.panel.querySelector('.twitch-resize-handle');

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

        // Кнопка свернуть
        minimizeBtn.addEventListener('click', () => {
            this.panel.classList.toggle('minimized');
        });

        // Кнопка закрыть
        closeBtn.addEventListener('click', () => {
            console.log('Twitch chat close button clicked');
            this.hide();
            this.disconnect();
            chrome.storage.sync.set({ twitch_chat_enabled: false });
        });
    }

    handleDrag(e) {
        if (!this.isDragging) return;

        const deltaX = e.clientX - this.dragStartX;
        const deltaY = e.clientY - this.dragStartY;

        const newX = this.panelStartX + deltaX;
        const newY = this.panelStartY + deltaY;

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

        this.savePosition();
    }

    handleResize(e) {
        if (!this.isResizing) return;

        const deltaX = e.clientX - this.resizeStartX;
        const deltaY = e.clientY - this.resizeStartY;

        let newWidth = this.startWidth + deltaX;
        let newHeight = this.startHeight + deltaY;

        // Применяем ограничения размеров
        newWidth = Math.max(this.minWidth, Math.min(newWidth, this.maxWidth));
        newHeight = Math.max(this.minHeight, Math.min(newHeight, this.maxHeight));

        // Проверяем границы экрана
        const rect = this.panel.getBoundingClientRect();
        const maxWidth = window.innerWidth - rect.left - 20; // 20px отступ от края
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
        
        console.log('Twitch panel resized to:', this.panel.style.width, this.panel.style.height);
    }

    savePosition() {
        const rect = this.panel.getBoundingClientRect();
        localStorage.setItem('twitch-chat-position', JSON.stringify({
            left: rect.left,
            top: rect.top
        }));
    }

    saveSize() {
        const rect = this.panel.getBoundingClientRect();
        localStorage.setItem('twitch-chat-size', JSON.stringify({
            width: rect.width,
            height: rect.height
        }));
    }

    loadPosition() {
        try {
            const position = JSON.parse(localStorage.getItem('twitch-chat-position'));
            if (position) {
                this.panel.style.left = `${position.left}px`;
                this.panel.style.top = `${position.top}px`;
                this.panel.style.right = 'auto';
            }
        } catch (error) {
            console.error('Failed to load Twitch panel position:', error);
        }
    }

    loadSize() {
        try {
            const size = JSON.parse(localStorage.getItem('twitch-chat-size'));
            if (size) {
                // Проверяем что размеры в допустимых пределах
                const width = Math.max(this.minWidth, Math.min(size.width, this.maxWidth));
                const height = Math.max(this.minHeight, Math.min(size.height, this.maxHeight));
                
                this.panel.style.width = `${width}px`;
                this.panel.style.height = `${height}px`;
                
                console.log('Loaded Twitch panel size:', width, 'x', height);
            }
        } catch (error) {
            console.error('Failed to load Twitch panel size:', error);
        }
    }


    updateChatDisplay() {
        const container = this.panel.querySelector('.twitch-chat-messages');
        if (!container) return;

        if (this.messages.length === 0) {
            container.innerHTML = '<div class="twitch-no-messages">Чат пуст</div>';
            return;
        }

        // Показываем только последние 3 сообщения для компактности
        const recentMessages = this.messages.slice(-3);
        
        container.innerHTML = recentMessages.map(msg => {
            if (msg.type === 'system') {
                return `
                    <div class="twitch-system-message">
                        ${msg.message}
                        <span class="twitch-timestamp">${this.formatTime(msg.timestamp)}</span>
                    </div>
                `;
            } else {
                return `
                    <div class="twitch-message">
                        <span class="twitch-username">${msg.username}:</span>
                        <span class="twitch-message-text">${this.escapeHtml(msg.message)}</span>
                        <span class="twitch-timestamp">${this.formatTime(msg.timestamp)}</span>
                    </div>
                `;
            }
        }).join('');

        // Прокручиваем вниз к новым сообщениям
        container.scrollTop = container.scrollHeight;
    }

    formatTime(date) {
        return date.toLocaleTimeString('ru-RU', { 
            hour: '2-digit', 
            minute: '2-digit' 
        });
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    show() {
        if (!this.hasActiveGameInterface()) {
            this.isGameUiVisible = false;
            return;
        }

        if (!this.panel) {
            this.createPanel();
        }

        this.panel.style.display = 'flex';
        this.panel.classList.add('show');
        this.panel.classList.remove('hide');
        this.isVisible = true;

        console.log('Showing Twitch chat panel');

        // Подключаемся к чату при показе
        if (this.channelName && !this.isConnected) {
            this.connectToTwitch();
        }
    }

    hide() {
        if (!this.panel) return;

        console.log('Hiding Twitch chat panel');

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
        console.log('Toggling Twitch panel, current state - isVisible:', this.isVisible, 'panel exists:', !!this.panel);
        
        if (this.isVisible) {
            this.hide();
        } else {
            this.show();
        }
    }

    destroy() {
        this.disconnect();
        
        if (this.panel) {
            this.panel.remove();
            this.panel = null;
        }

        const styles = document.getElementById('twitch-chat-panel-styles');
        if (styles) {
            styles.remove();
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
}

// Инициализация панели при загрузке страницы
let twitchChatPanel = null;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTwitchChatPanel);
} else {
    initTwitchChatPanel();
}

function initTwitchChatPanel() {
    if (window.location.hostname.includes('polemicagame.com')) {
        twitchChatPanel = new FloatingTwitchChatPanel();
        console.log('Twitch Chat Panel initialized');
    }
}

window.twitchChatPanel = twitchChatPanel;
