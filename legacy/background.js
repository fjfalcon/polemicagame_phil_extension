// Удалена функция createMusicControlPanel и все связанные с музыкальным плеером функции

/**
 * OBS WebSocket Integration в Service Worker
 */
class BackgroundOBSWebSocket {
    constructor() {
        this.socket = null;
        this.sessionId = null;
        this.isConnected = false;
        this.requestId = 1;
        this.pendingRequests = new Map();
        this.scenes = [];
        this.currentScene = null;
        this.connectionSettings = null;
        this.reconnectTimer = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10; // Увеличиваем максимум попыток
        this.heartbeatTimer = null;
        this.lastHeartbeat = Date.now();
        this.heartbeatInterval = 30000; // 30 секунд
        this.connectionTimeout = 10000; // Увеличиваем таймаут до 10 секунд
    }

    async connect(url, password = '') {
        try {
            // Сохраняем настройки для переподключения
            this.connectionSettings = { url, password };
            
            return new Promise((resolve, reject) => {
                this.socket = new WebSocket(url);
                
                this.socket.onopen = () => {
                    console.log('OBS WebSocket connected in background');
                    this.identify(password).then(() => {
                        this.isConnected = true;
                        this.sessionId = typeof crypto !== 'undefined' && crypto.randomUUID
                            ? crypto.randomUUID()
                            : `obs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
                        this.reconnectAttempts = 0;
                        this.lastHeartbeat = Date.now();
                        this.startHeartbeat();
                        this.saveConnectionState(true);
                        resolve(true);
                    }).catch(reject);
                };

                this.socket.onclose = (event) => {
                    console.log('OBS WebSocket disconnected in background, code:', event.code, 'reason:', event.reason);
                    this.isConnected = false;
                    this.sessionId = null;
                    this.socket = null;
                    this.stopHeartbeat();
                    this.clearAutoSceneState();
                    this.saveConnectionState(false);
                    this.notifyPopup('obs_disconnected');
                    
                    // Автопереподключение только если не было нормального закрытия
                    if (event.code !== 1000) {
                    this.attemptReconnect();
                    }
                };

                this.socket.onerror = (error) => {
                    console.error('OBS WebSocket error:', error);
                    this.isConnected = false;
                    this.stopHeartbeat();
                    reject(error);
                };

                this.socket.onmessage = (event) => {
                    this.lastHeartbeat = Date.now();
                    this.handleMessage(JSON.parse(event.data));
                };

                setTimeout(() => {
                    if (!this.isConnected) {
                        this.socket.close();
                        reject(new Error('Connection timeout'));
                    }
                }, this.connectionTimeout);
            });
        } catch (error) {
            console.error('Failed to connect to OBS:', error);
            throw error;
        }
    }

    attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts || !this.connectionSettings) {
            console.log('Max reconnect attempts reached or no connection settings');
            return;
        }

        this.reconnectAttempts++;
        console.log(`OBS WebSocket reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);

        // Экспоненциальная задержка с максимумом 30 секунд
        const delay = Math.min(2000 * this.reconnectAttempts, 30000);
        
        this.reconnectTimer = setTimeout(async () => {
            try {
                console.log(`Attempting to reconnect to OBS... (${this.connectionSettings.url})`);
                await this.connect(this.connectionSettings.url, this.connectionSettings.password);
                console.log('OBS WebSocket reconnected successfully');
            } catch (error) {
                console.error('OBS WebSocket reconnect failed:', error);
                this.attemptReconnect();
            }
        }, delay);
    }

    startHeartbeat() {
        this.stopHeartbeat(); // Останавливаем предыдущий heartbeat

        this.heartbeatTimer = setInterval(() => {
            const timeSinceLastMessage = Date.now() - this.lastHeartbeat;

            if (timeSinceLastMessage > this.heartbeatInterval * 2) {
                console.log('OBS WebSocket heartbeat timeout, attempting reconnect...');
                this.handleConnectionLost();
            } else {
                // Отправляем ping для поддержания соединения
                this.sendHeartbeat();
            }
        }, this.heartbeatInterval);
    }

    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    sendHeartbeat() {
        if (!this.isConnected || !this.socket) return;

        try {
            // Отправляем простой запрос статуса для поддержания соединения
            this.request('GetVersion').catch(() => {
                // Игнорируем ошибки heartbeat
            });
        } catch (error) {
            console.log('Heartbeat failed:', error);
        }
    }

    handleConnectionLost() {
        console.log('Connection to OBS lost, cleaning up...');
        this.isConnected = false;
        this.sessionId = null;
        this.stopHeartbeat();

        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }

        this.clearAutoSceneState();
        this.notifyPopup('obs_disconnected');
        this.attemptReconnect();
    }

    disconnect() {
        console.log('Manually disconnecting from OBS...');

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this.stopHeartbeat();
        
        if (this.socket) {
            this.socket.close(1000, 'Manual disconnect'); // Нормальное закрытие
            this.socket = null;
        }
        
        this.isConnected = false;
        this.sessionId = null;
        this.scenes = [];
        this.currentScene = null;
        this.connectionSettings = null;
        this.reconnectAttempts = 0;
        
        // Уведомляем всех о отключении
        this.notifyPopup('obs_disconnected');
        this.notifyContentScripts('obs_disconnected');
        
        this.clearAutoSceneState();
        this.saveConnectionState(false);
    }

    async identify(password = '') {
        const message = {
            op: 1,
            d: {
                rpcVersion: 1,
                authentication: password || undefined,
                eventSubscriptions: 1023 // Подписываемся на все события (0x3FF = 1023)
            }
        };
        
        console.log('Identifying with OBS, subscribing to all events');
        this.send(message);
    }

    send(message) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket is not connected');
        }
        this.socket.send(JSON.stringify(message));
    }

    handleMessage(message) {
        console.log('OBS WebSocket message received:', message.op, message.d);
        
        switch (message.op) {
            case 0: // Hello
                console.log('Received Hello from OBS:', message.d);
                break;
            case 2: // Identified
                console.log('Successfully identified with OBS');
                this.requestSceneList();
                break;
            case 5: // Event
                console.log('OBS Event received:', message.d);
                this.handleEvent(message.d);
                break;
            case 7: // RequestResponse
                console.log('OBS Response received:', message.d);
                this.handleResponse(message.d);
                break;
            default:
                console.log('Unknown OBS WebSocket message:', message);
        }
    }

    handleEvent(eventData) {
        console.log('🎬 OBS Event Details:', {
            type: eventData.eventType,
            data: eventData.eventData,
            intent: eventData.eventIntent
        });
        
        switch (eventData.eventType) {
            case 'CurrentProgramSceneChanged':
                console.log('🔄 Scene changed to:', eventData.eventData.sceneName);
                this.currentScene = eventData.eventData.sceneName;
                
                // Уведомляем popup и content script о смене сцены
                console.log('📢 Notifying popup and content scripts about scene change');
                this.notifyPopup('obs_scene_changed', this.currentScene);
                this.notifyContentScripts('obs_scene_changed', this.currentScene);
                
                // Обновляем сохраненное состояние
                this.saveConnectionState(true);
                break;
                
            case 'CurrentPreviewSceneChanged':
                console.log('👁️ Preview scene changed to:', eventData.eventData.sceneName);
                break;
                
            case 'SceneListChanged':
                console.log('📝 Scene list changed, requesting update...');
                this.requestSceneList();
                break;
                
            case 'SceneNameChanged':
                console.log('✏️ Scene renamed:', eventData.eventData.oldSceneName, 'to', eventData.eventData.sceneName);
                this.requestSceneList();
                break;
                
            case 'SceneCreated':
                console.log('➕ Scene created:', eventData.eventData.sceneName);
                this.requestSceneList();
                break;
                
            case 'SceneRemoved':
                console.log('➖ Scene removed:', eventData.eventData.sceneName);
                this.requestSceneList();
                break;
                
            case 'SceneTransitionStarted':
                console.log('🔄 Scene transition started');
                break;
                
            case 'SceneTransitionEnded':
                console.log('✅ Scene transition ended');
                break;
                
            default:
                console.log('❓ Unknown OBS event:', eventData.eventType, eventData.eventData);
        }
    }

    handleResponse(responseData) {
        const { requestId, requestStatus } = responseData;
        
        if (this.pendingRequests.has(requestId)) {
            const { resolve, reject } = this.pendingRequests.get(requestId);
            this.pendingRequests.delete(requestId);

            if (requestStatus.result) {
                resolve(responseData.responseData);
            } else {
                reject(new Error(requestStatus.comment));
            }
        }
    }

    request(requestType, requestData = {}) {
        return new Promise((resolve, reject) => {
            const requestId = this.requestId++;
            
            this.pendingRequests.set(requestId, { resolve, reject });

            const message = {
                op: 6,
                d: {
                    requestType,
                    requestId,
                    requestData
                }
            };

            try {
                this.send(message);
            } catch (error) {
                this.pendingRequests.delete(requestId);
                reject(error);
            }

            setTimeout(() => {
                if (this.pendingRequests.has(requestId)) {
                    this.pendingRequests.delete(requestId);
                    reject(new Error('Request timeout'));
                }
            }, 10000);
        });
    }

    async requestSceneList() {
        try {
            const response = await this.request('GetSceneList');
            this.scenes = response.scenes || [];
            this.currentScene = response.currentProgramSceneName;
            
            console.log('Scene list updated:', this.scenes.length, 'scenes, current:', this.currentScene);
            
            // Уведомляем popup и content scripts о новых сценах
            const sceneData = {
                scenes: this.scenes,
                currentScene: this.currentScene
            };
            
            this.notifyPopup('obs_scenes_updated', sceneData);
            this.notifyContentScripts('obs_scenes_updated', sceneData);
            
            // Обновляем сохраненное состояние
            this.saveConnectionState(true);
            
            return this.scenes;
        } catch (error) {
            console.error('Failed to get scene list:', error);
            throw error;
        }
    }

    async setCurrentScene(sceneName) {
        try {
            await this.request('SetCurrentProgramScene', { sceneName });
            this.currentScene = sceneName;
            
            console.log('Scene changed programmatically to:', sceneName);
            
            // Уведомляем popup и content scripts о смене сцены
            this.notifyPopup('obs_scene_changed', sceneName);
            this.notifyContentScripts('obs_scene_changed', sceneName);
            
            // Обновляем сохраненное состояние
            this.saveConnectionState(true);
            
            return true;
        } catch (error) {
            console.error('Failed to set scene:', error);
            throw error;
        }
    }

    // Получение статуса подключения
    getStatus() {
        return {
            connected: this.isConnected,
            scenes: this.scenes,
            currentScene: this.currentScene,
            reconnectAttempts: this.reconnectAttempts,
            lastHeartbeat: this.lastHeartbeat,
            connectionSettings: this.connectionSettings
        };
    }

    // Сохранение состояния подключения
    async saveConnectionState(connected) {
        await chrome.storage.local.set({
            obs_connection_state: {
                connected,
                scenes: this.scenes,
                currentScene: this.currentScene,
                sessionId: this.sessionId,
                timestamp: Date.now()
            }
        });
    }

    async clearAutoSceneState() {
        try {
            await chrome.storage.local.remove('obs_auto_scene_state');
        } catch (error) {
            console.error('Failed to clear OBS auto scene state:', error);
        }
    }

    // Уведомление popup через runtime.sendMessage
    notifyPopup(type, data = null) {
        console.log('📨 Sending to popup:', type, data);
        // Отправляем сообщение всем открытым popup
        chrome.runtime.sendMessage({
            type: 'obs_event',
            eventType: type,
            data: data
        }).catch(() => {
            // Popup может быть закрыт, это нормально
            console.log('❌ Failed to notify popup (may be closed):', type);
        });
    }

    // Уведомление всех content scripts на активных вкладках
    notifyContentScripts(type, data = null) {
        console.log('📨 Sending to content scripts:', type, data);
        chrome.tabs.query({url: '*://*.polemicagame.com/*'}, (tabs) => {
            console.log('🔍 Found tabs:', tabs.length);
            tabs.forEach(tab => {
                console.log('📤 Sending to tab:', tab.id, tab.url);
                chrome.tabs.sendMessage(tab.id, {
                    type: 'obs_event',
                    eventType: type,
                    data: data
                }).catch(() => {
                    // Content script может быть не загружен, это нормально
                    console.log('❌ Failed to notify content script on tab', tab.id);
                });
            });
        });
    }

    getConnectionStatus() {
        return {
            connected: this.isConnected,
            scenes: this.scenes,
            currentScene: this.currentScene,
            sessionId: this.sessionId
        };
    }
}

// Глобальный экземпляр OBS WebSocket
let backgroundOBS = new BackgroundOBSWebSocket();

// Обработка сообщений от popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'obs_command') {
        handleOBSCommand(request.command, request.data)
            .then(result => sendResponse({ success: true, data: result }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true; // Асинхронный ответ
    }
    
    // Существующая логика для автопринятия игр
    if (request.action === "startSearch") {
        // ... остальной код остается без изменений
        handleGameSearch(sender, sendResponse);
        return true;
    }
    
    return true;
});

// Обработка команд OBS от popup
async function handleOBSCommand(command, data) {
    switch (command) {
        case 'connect':
            return await backgroundOBS.connect(data.url, data.password);
            
        case 'disconnect':
            backgroundOBS.disconnect();
            return true;
            
        case 'get_status':
            return backgroundOBS.getConnectionStatus();
            
        case 'set_scene':
            return await backgroundOBS.setCurrentScene(data.sceneName);
            
        case 'get_scenes':
            return await backgroundOBS.requestSceneList();
            
        default:
            throw new Error(`Unknown OBS command: ${command}`);
    }
}

// Автозапуск OBS подключения при старте расширения
chrome.runtime.onStartup.addListener(async () => {
    await restoreOBSConnection();
});

chrome.runtime.onInstalled.addListener(async () => {
    await restoreOBSConnection();
});

// Восстановление подключения при запуске
async function restoreOBSConnection() {
    try {
        const settings = await chrome.storage.sync.get(['obs_enabled', 'obs_host', 'obs_password']);
        
        if (settings.obs_enabled && settings.obs_host) {
            console.log('Restoring OBS connection...');
            setTimeout(async () => {
                try {
                    await backgroundOBS.connect(settings.obs_host, settings.obs_password || '');
                    console.log('OBS connection restored successfully');
                } catch (error) {
                    console.error('Failed to restore OBS connection:', error);
                }
            }, 2000); // Небольшая задержка для стабильности
        }
    } catch (error) {
        console.error('Error restoring OBS connection:', error);
    }
}

// Функция для обработки автопринятия игр (вынесена из основного обработчика)
function handleGameSearch(sender, sendResponse) {
        // Сначала инжектируем функцию
  chrome.scripting.executeScript({
            target: { tabId: sender.tab.id },
            func: () => {
                console.log('🎮 Игра найдена! Запускаем автопринятие...');
                
                function clickStartButton() {
                    console.log('🔍 Поиск кнопки принятия...');
                    
                    // Расширенный список селекторов для кнопок
                    const buttonSelectors = [
                        'button.button-comp.outline',
                        'button.button.preset-1',
                        '.button-comp.outline',
                        '.button.preset-1',
                        '[class*="button"][class*="primary"]',
                        '[class*="button"][class*="accept"]',
                        'button'
                    ];
                    
                    let buttonFound = false;
                    
                    // Проверяем каждый селектор
                    for (const selector of buttonSelectors) {
                        const buttons = document.querySelectorAll(selector);
                        console.log(`Найдено ${buttons.length} элементов по селектору "${selector}"`);
                        
                        // Проверяем каждую найденную кнопку
                        buttons.forEach(button => {
                            const buttonText = button.textContent.trim().toLowerCase();
                            console.log(`Проверяем кнопку: "${buttonText}"`);
                            
                            if (buttonText.includes('начать игру') || 
                                buttonText.includes('готов') || 
                                buttonText.includes('подтвердить') ||
                                buttonText.includes('принять') ||
                                buttonText.includes('старт') ||
                                buttonText.includes('join')) {
                                
                                console.log('✅ Нашли нужную кнопку! Нажимаем...');
                                try {
                                    button.click();
                                    buttonFound = true;
                                } catch (e) {
                                    console.error('Ошибка при нажатии click():', e);
                                    try {
                                        // Альтернативный способ клика через событие
                                        const event = new MouseEvent('click', {
                                            bubbles: true,
                                            cancelable: true,
                                            view: window
                                        });
                                        button.dispatchEvent(event);
                                        buttonFound = true;
                                    } catch (e2) {
                                        console.error('Ошибка при отправке события:', e2);
                                    }
                                }
                            }
                        });
                        
                        if (buttonFound) break;
                    }
                    
                    // Поиск модального окна принятия
                    if (!buttonFound) {
                        const gameFoundModal = document.querySelector('.common-room-modal') || 
                                            document.querySelector('[class*="modal"]') ||
                                            document.querySelector('[class*="popup"]');
                        
                        if (gameFoundModal) {
                            console.log('🎯 Найдено модальное окно для принятия игры');
                            const modalButtons = gameFoundModal.querySelectorAll('button') || 
                                              gameFoundModal.querySelectorAll('[class*="button"]');
                            
                            modalButtons.forEach(button => {
                                const buttonText = button.textContent.trim().toLowerCase();
                                if (buttonText.includes('готов') || 
                                    buttonText.includes('начать') || 
                                    buttonText.includes('подтвердить') ||
                                    buttonText.includes('принять')) {
                                    
                                    console.log('🎮 Нажимаем кнопку в модальном окне:', buttonText);
                                    try {
                                        button.click();
                                        buttonFound = true;
                                    } catch (e) {
                                        console.error('Ошибка при нажатии на кнопку:', e);
                                    }
                                }
                            });
                        }
                    }
                    
                    return buttonFound;
                }

                // Пробуем нажать сразу
                if (!clickStartButton()) {
                    console.log('⏳ Ждем появления кнопки...');
                    
                    // Проверяем каждые 100мс
                    const checkInterval = setInterval(() => {
                        if (clickStartButton()) {
                            console.log('🎉 Успешно нажали кнопку!');
                            clearInterval(checkInterval);
                        }
                    }, 100);

                    // Останавливаем через 10 секунд
                    setTimeout(() => {
                        clearInterval(checkInterval);
                        console.log('⚠️ Время ожидания истекло');
                    }, 10000);
                }
                
                // Наблюдаем за изменениями DOM для поиска новых кнопок
                const observer = new MutationObserver(() => {
                    clickStartButton();
                });
                
                observer.observe(document.body, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ['class', 'style', 'display']
                });
                
                // Останавливаем наблюдатель через 10 секунд
                setTimeout(() => {
                    observer.disconnect();
                }, 10000);
            }
        });
    }
