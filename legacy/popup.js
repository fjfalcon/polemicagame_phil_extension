// OBS интеграция теперь работает через background service worker

document.addEventListener('DOMContentLoaded', () => {
    let popupToastTimer = null;
    function showPopupToast(message, type = 'success', timeoutMs = 8000) {
        const notification = document.getElementById('notification');
        if (!notification) {
            alert(message);
            return;
        }

        notification.textContent = message;
        notification.style.background = type === 'success' ? 'rgba(73, 191, 165, 0.12)' : 'rgba(239, 68, 68, 0.12)';
        notification.style.color = type === 'success' ? '#49BFA5' : '#ef4444';
        notification.classList.add('show');

        if (popupToastTimer) clearTimeout(popupToastTimer);
        popupToastTimer = setTimeout(() => notification.classList.remove('show'), timeoutMs);
    }

    const nicklenOverlay = document.getElementById('nicklen_overlay');
    const nicklenBody = document.getElementById('nicklen_modal_body');
    const nicklenClose = document.getElementById('nicklen_close');
    function openNicklenModal(message) {
        if (!nicklenOverlay || !nicklenBody) {
            showPopupToast(message, 'success', 12000);
            return;
        }
        nicklenBody.textContent = message;
        nicklenOverlay.style.display = 'flex';
        requestAnimationFrame(() => nicklenOverlay.classList.add('show'));
    }
    function closeNicklenModal() {
        if (!nicklenOverlay) return;
        nicklenOverlay.classList.remove('show');
        setTimeout(() => {
            nicklenOverlay.style.display = 'none';
        }, 170);
    }
    if (nicklenClose) nicklenClose.addEventListener('click', closeNicklenModal);
    if (nicklenOverlay) nicklenOverlay.addEventListener('click', (e) => {
        if (e.target === nicklenOverlay) closeNicklenModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeNicklenModal();
    });

    // Изменяем обработчик кнопки активации (элемент может отсутствовать)
    const activateBtn = document.getElementById('activate_script');
    if (activateBtn) activateBtn.addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        
        if (tab.url.includes('polemicagame.com')) {
            // Переактивируем скрипты
            chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content-notes.js', 'role-faker.js']
            });
            
            // Устанавливаем флаг активации
            chrome.storage.local.set({ scriptActivated: true });
            
            // Обновляем вид кнопки
            const button = document.getElementById('activate_script');
            button.textContent = 'Скрипт активирован';
            button.style.backgroundColor = '#4CAF50';
        } else {
            alert('Скрипт работает только на polemicagame.com');
        }
    });

    const nicknameLengthsBtn = document.getElementById('show_nickname_lengths');
    if (nicknameLengthsBtn) nicknameLengthsBtn.addEventListener('click', async () => {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id || !tab.url || !tab.url.includes('polemicagame.com')) {
                showPopupToast('Открой polemicagame.com и страницу игры', 'error');
                return;
            }

            const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                    const nodes = Array.from(document.querySelectorAll('.player__info.info, .player__info'));
                    const players = [];
                    for (const node of nodes) {
                        const nameEl = node.querySelector('.info__name');
                        if (!nameEl) continue;
                        const name = (nameEl.textContent || '').trim();
                        if (!name) continue;

                        const numberEl = node.querySelector('.player-number');
                        const rawNumber = numberEl ? (numberEl.textContent || '').trim() : '';
                        const parsed = Number.parseInt(rawNumber, 10);
                        const number = Number.isFinite(parsed) ? parsed : (players.length + 1);

                        players.push({ number, name, length: Array.from(name).length });
                    }

                    const byNumber = new Map();
                    for (const p of players) {
                        if (!byNumber.has(p.number)) byNumber.set(p.number, p);
                    }

                    const uniquePlayers = Array.from(byNumber.values()).sort((a, b) => a.number - b.number);
                    const total = uniquePlayers.reduce((sum, p) => sum + p.length, 0);
                    return { players: uniquePlayers, total };
                }
            });

            const data = results?.[0]?.result;
            if (!data?.players || data.players.length === 0) {
                showPopupToast('Не нашёл игроков на странице', 'error');
                return;
            }

            const lines = [];
            lines.push('Кол-во символов в никнеймах:');
            lines.push(`Всего: ${data.total}`);
            for (const p of data.players) {
                lines.push(`${p.number}) ${p.name} — ${p.length}`);
            }

            openNicklenModal(lines.join('\n'));
        } catch (error) {
            showPopupToast('Не удалось получить ники со страницы', 'error');
        }
    });

    // Загружаем сохраненные настройки
    chrome.storage.sync.get({
        // Значения по умолчанию
        show_mmr: true,
        show_games: true,
        show_id: false,
        show_winrate: true,
        show_kills: true,
        show_roles: true,
        enable_role_faker: false,
        disable_webcam_clicks: false,
        auto_accept_enabled: true,
        skip_start_screen_enabled: true,
        pause_hotkey_enabled: true,
        statistics_enabled: true,
        match_page_stats_enabled: true,
        stats_button_theme: 'default',
        auto_hide_roles_enabled: false,
        role_phase_auto_switch_enabled: false,
        // OBS settings
        obs_enabled: false,
        obs_host: 'ws://localhost:4455',
        obs_password: '',
        obs_floating_panel_enabled: false,
        obs_auto_mode_enabled: false,
        obs_day_scene: '',
        obs_night_scene: '',
        // Twitch settings
        twitch_chat_enabled: false,
        twitch_channel_name: '',
        twitch_floating_panel_enabled: false,
        enable_role_faker: false,
    }, (items) => {
        document.getElementById('show_mmr').checked = items.show_mmr;
        document.getElementById('show_games').checked = items.show_games;
        document.getElementById('show_id').checked = items.show_id;
        document.getElementById('show_winrate').checked = items.show_winrate;
        document.getElementById('show_kills').checked = items.show_kills;
        document.getElementById('show_roles').checked = items.show_roles;
        document.getElementById('enable_role_faker').checked = items.enable_role_faker;
        const sse = document.getElementById('skip_start_screen_enabled');
        if (sse) sse.checked = items.skip_start_screen_enabled;
        const phe = document.getElementById('pause_hotkey_enabled');
        if (phe) phe.checked = items.pause_hotkey_enabled;
        const se = document.getElementById('statistics_enabled');
        if (se) se.checked = items.statistics_enabled;
        const mpse = document.getElementById('match_page_stats_enabled');
        if (mpse) mpse.checked = items.match_page_stats_enabled;
        const sbt = document.getElementById('stats_button_theme');
        if (sbt) sbt.value = items.stats_button_theme || 'default';
        const ahre = document.getElementById('auto_hide_roles_enabled');
        if (ahre) ahre.checked = items.auto_hide_roles_enabled;
        const rpase = document.getElementById('role_phase_auto_switch_enabled');
        if (rpase) {
            rpase.checked = items.auto_hide_roles_enabled ? items.role_phase_auto_switch_enabled : false;
            rpase.disabled = !items.auto_hide_roles_enabled;
        }
        const dwc = document.getElementById('disable_webcam_clicks');
        if (dwc) dwc.checked = items.disable_webcam_clicks;
        const aae = document.getElementById('auto_accept_enabled');
        if (aae) aae.checked = items.auto_accept_enabled;
        
        // Загружаем настройки OBS
        const obsEnabled = document.getElementById('obs_enabled');
        const obsHost = document.getElementById('obs_host');
        const obsPassword = document.getElementById('obs_password');
        const obsSettings = document.getElementById('obs_settings');
        
        if (obsEnabled) {
            obsEnabled.checked = items.obs_enabled;
            obsSettings.style.display = items.obs_enabled ? 'block' : 'none';
        }
        if (obsHost) obsHost.value = items.obs_host;
        if (obsPassword) obsPassword.value = items.obs_password;
        
        // Загружаем настройки плавающей панели
        const obsFloatingEnabled = document.getElementById('obs_floating_panel_enabled');
        if (obsFloatingEnabled) {
            obsFloatingEnabled.checked = items.obs_floating_panel_enabled;
        }

        // Загружаем настройки автоматического режима
        const obsAutoModeEnabled = document.getElementById('obs_auto_mode_enabled');
        const obsAutoSettings = document.getElementById('obs_auto_settings');
        if (obsAutoModeEnabled) {
            obsAutoModeEnabled.checked = items.obs_auto_mode_enabled;
            if (obsAutoSettings) {
                obsAutoSettings.style.display = items.obs_auto_mode_enabled ? 'block' : 'none';
            }
        }
        
        // Загружаем настройки Twitch
        const twitchEnabled = document.getElementById('twitch_chat_enabled');
        const twitchChannelName = document.getElementById('twitch_channel_name');
        const twitchSettings = document.getElementById('twitch_settings');
        const twitchFloatingEnabled = document.getElementById('twitch_floating_panel_enabled');
        
        if (twitchEnabled) {
            twitchEnabled.checked = items.twitch_chat_enabled;
            twitchSettings.style.display = items.twitch_chat_enabled ? 'block' : 'none';
        }
        if (twitchChannelName) twitchChannelName.value = items.twitch_channel_name;
        if (twitchFloatingEnabled) {
            twitchFloatingEnabled.checked = items.twitch_floating_panel_enabled;
        }
    });

    // Сохраняем настройки при изменении
    const saveSettings = () => {
        const autoHideRolesEnabled = (document.getElementById('auto_hide_roles_enabled')?.checked) ?? false;
        const settings = {
            show_mmr: document.getElementById('show_mmr').checked,
            show_games: document.getElementById('show_games').checked,
            show_id: document.getElementById('show_id').checked,
            show_winrate: document.getElementById('show_winrate').checked,
            show_kills: document.getElementById('show_kills').checked,
            show_roles: document.getElementById('show_roles').checked,
            enable_role_faker: document.getElementById('enable_role_faker').checked,
            disable_webcam_clicks: (document.getElementById('disable_webcam_clicks')?.checked) || false,
            auto_accept_enabled: (document.getElementById('auto_accept_enabled')?.checked) ?? true,
            skip_start_screen_enabled: (document.getElementById('skip_start_screen_enabled')?.checked) ?? true,
            pause_hotkey_enabled: (document.getElementById('pause_hotkey_enabled')?.checked) ?? true,
            statistics_enabled: (document.getElementById('statistics_enabled')?.checked) ?? true,
            match_page_stats_enabled: (document.getElementById('match_page_stats_enabled')?.checked) ?? true,
            stats_button_theme: document.getElementById('stats_button_theme')?.value || 'default',
            auto_hide_roles_enabled: autoHideRolesEnabled,
            role_phase_auto_switch_enabled: autoHideRolesEnabled && ((document.getElementById('role_phase_auto_switch_enabled')?.checked) ?? false),
            // OBS settings
            obs_enabled: (document.getElementById('obs_enabled')?.checked) || false,
            obs_host: document.getElementById('obs_host')?.value || 'ws://localhost:4455',
            obs_password: document.getElementById('obs_password')?.value || '',
            obs_floating_panel_enabled: (document.getElementById('obs_floating_panel_enabled')?.checked) || false,
            obs_auto_mode_enabled: (document.getElementById('obs_auto_mode_enabled')?.checked) || false,
            obs_day_scene: document.getElementById('obs_day_scene')?.value || '',
            obs_night_scene: document.getElementById('obs_night_scene')?.value || '',
            // Twitch settings
            twitch_chat_enabled: (document.getElementById('twitch_chat_enabled')?.checked) || false,
            twitch_channel_name: document.getElementById('twitch_channel_name')?.value || '',
            twitch_floating_panel_enabled: (document.getElementById('twitch_floating_panel_enabled')?.checked) || false,
        };
        chrome.storage.sync.set(settings);
        
        // Отправляем сообщения для обновления настроек в активную вкладку
        chrome.tabs.query({url: '*://*.polemicagame.com/*'}, function(tabs) {
            tabs.forEach((tab) => {
                // Обновление Role Faker
                chrome.tabs.sendMessage(tab.id, {
                    type: 'updateRoleFaker',
                    enabled: settings.enable_role_faker
                });

                // Обновление настроек заметок/подсказок (включая show_id)
                chrome.tabs.sendMessage(tab.id, {
                    type: 'updateNotesSettings',
                    settings
                });
            });
        });
    };

    // Добавляем обработчики событий
    document.getElementById('show_mmr').addEventListener('change', saveSettings);
    document.getElementById('show_games').addEventListener('change', saveSettings);
    document.getElementById('show_id').addEventListener('change', saveSettings);
    document.getElementById('show_winrate').addEventListener('change', saveSettings);
    document.getElementById('show_kills').addEventListener('change', saveSettings);
    document.getElementById('show_roles').addEventListener('change', saveSettings);
    document.getElementById('enable_role_faker').addEventListener('change', saveSettings);
    const featureSettingIds = [
        'skip_start_screen_enabled',
        'pause_hotkey_enabled',
        'statistics_enabled',
        'match_page_stats_enabled',
        'stats_button_theme',
        'auto_hide_roles_enabled',
        'role_phase_auto_switch_enabled'
    ];
    featureSettingIds.forEach((id) => {
        const element = document.getElementById(id);
        if (element) element.addEventListener('change', saveSettings);
    });
    const autoHideRolesToggle = document.getElementById('auto_hide_roles_enabled');
    const rolePhaseToggle = document.getElementById('role_phase_auto_switch_enabled');
    if (autoHideRolesToggle && rolePhaseToggle) {
        autoHideRolesToggle.addEventListener('change', () => {
            rolePhaseToggle.disabled = !autoHideRolesToggle.checked;
            if (!autoHideRolesToggle.checked) {
                rolePhaseToggle.checked = false;
            }
        });
    }
    const dwcToggle = document.getElementById('disable_webcam_clicks');
    if (dwcToggle) dwcToggle.addEventListener('change', saveSettings);
    const aaeToggle = document.getElementById('auto_accept_enabled');
    if (aaeToggle) aaeToggle.addEventListener('change', saveSettings);
    
    // OBS event listeners
    setupOBSHandlers();
    
    // Twitch event listeners
    setupTwitchHandlers();
    
    // Обработка событий от background OBS
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        console.log('📩 Popup received message:', message);
        if (message.type === 'obs_event') {
            handleOBSEvent(message.eventType, message.data);
            sendResponse({ received: true });
        }
        return true;
    });
    
    /**
     * Обработка событий от background OBS
     */
    function handleOBSEvent(eventType, data) {
        console.log('Popup received OBS event:', eventType, data);
        
        switch (eventType) {
            case 'obs_scenes_updated':
                if (data && data.scenes) {
                    updateScenesList(data.scenes, data.currentScene);
                    updateOBSStatus('Подключено', true);
                }
                break;
                
            case 'obs_scene_changed':
                console.log('Scene changed in popup to:', data);
                updateCurrentSceneHighlight(data);
                break;
                
            case 'obs_disconnected':
                console.log('OBS disconnected in popup');
                updateOBSStatus('Отключено', false);
                updateScenesList([]);
                break;
        }
    }

    /**
     * Отправка сообщения в content script плавающей панели
     */
    function sendMessageToContentScript(type, data = {}) {
        console.log('Sending message to content script:', type, data);
        chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
            if (tabs[0] && tabs[0].url && tabs[0].url.includes('polemicagame.com')) {
                try {
                    chrome.tabs.sendMessage(tabs[0].id, {
                        type: type,
                        data: data
                    }, (response) => {
                        // Проверяем ошибки Chrome runtime
                        if (chrome.runtime.lastError) {
                            console.log('Content script not available:', chrome.runtime.lastError.message);
                            // Показываем пользователю что нужно перезагрузить страницу
                            showContentScriptError();
                            return;
                        }
                        console.log('Response from content script:', response);
                    });
                } catch (error) {
                    console.log('Failed to send message to content script:', error);
                    showContentScriptError();
                }
            } else {
                console.log('Not on polemicagame.com or tab not found');
                showWrongPageError();
            }
        });
    }

    /**
     * Показать ошибку что content script не доступен
     */
    function showContentScriptError() {
        const statusElement = document.getElementById('obs_status');
        if (statusElement) {
            statusElement.textContent = '⚠️ Перезагрузите страницу игры';
            statusElement.style.color = '#ff9800';
        }
    }

    /**
     * Показать ошибку что нужна страница игры
     */
    function showWrongPageError() {
        const statusElement = document.getElementById('obs_status');
        if (statusElement) {
            statusElement.textContent = '⚠️ Откройте страницу игры';
            statusElement.style.color = '#ff9800';
        }
    }

    /**
     * Настройка обработчиков Twitch
     */
    function setupTwitchHandlers() {
        const twitchEnabled = document.getElementById('twitch_chat_enabled');
        const twitchSettings = document.getElementById('twitch_settings');
        const twitchConnect = document.getElementById('twitch_connect');
        const twitchDisconnect = document.getElementById('twitch_disconnect');
        const twitchChannelName = document.getElementById('twitch_channel_name');
        const twitchFloatingEnabled = document.getElementById('twitch_floating_panel_enabled');
        const showTwitchPanel = document.getElementById('show_twitch_panel');
        const hideTwitchPanel = document.getElementById('hide_twitch_panel');

        // Переключатель включения Twitch
        if (twitchEnabled) {
            twitchEnabled.addEventListener('change', (e) => {
                const enabled = e.target.checked;
                twitchSettings.style.display = enabled ? 'block' : 'none';
                
                if (!enabled) {
                    // Отключаем через content script
                    sendMessageToContentScript('twitch_disconnect');
                    updateTwitchStatus('Не подключен', false);
                }
                
                saveSettings();
            });
        }

        // Кнопка подключения
        if (twitchConnect) {
            twitchConnect.addEventListener('click', () => {
                const channel = twitchChannelName?.value.trim() || '';
                
                if (!channel) {
                    updateTwitchStatus('Введите имя канала', false);
                    return;
                }

                try {
                    twitchConnect.disabled = true;
                    twitchConnect.textContent = 'Подключение...';
                    updateTwitchStatus('Подключение к чату...', false);
                    
                    // Подключаемся через content script
                    sendMessageToContentScript('twitch_connect', { channel });
                    
                    setTimeout(() => {
                        twitchConnect.textContent = 'Подключиться';
                        twitchConnect.disabled = false;
                        updateTwitchStatus('Подключено', true);
                        saveSettings();
                    }, 2000);
                    
                } catch (error) {
                    console.error('Twitch connection failed:', error);
                    updateTwitchStatus(`Ошибка: ${error.message}`, false);
                    twitchConnect.textContent = 'Подключиться';
                    twitchConnect.disabled = false;
                }
            });
        }

        // Кнопка отключения
        if (twitchDisconnect) {
            twitchDisconnect.addEventListener('click', () => {
                sendMessageToContentScript('twitch_disconnect');
                updateTwitchStatus('Не подключен', false);
            });
        }

        // Обработчики изменения настроек
        if (twitchChannelName) {
            twitchChannelName.addEventListener('change', saveSettings);
        }
        if (twitchFloatingEnabled) {
            twitchFloatingEnabled.addEventListener('change', saveSettings);
        }

        // Кнопки управления плавающей панелью
        if (showTwitchPanel) {
            showTwitchPanel.addEventListener('click', () => {
                console.log('Show Twitch panel button clicked');
                const twitchFloatingEnabled = document.getElementById('twitch_floating_panel_enabled');
                if (twitchFloatingEnabled) {
                    twitchFloatingEnabled.checked = true;
                    saveSettings();
                }
                sendMessageToContentScript('twitch_panel_show');
            });
        }

        if (hideTwitchPanel) {
            hideTwitchPanel.addEventListener('click', () => {
                console.log('Hide Twitch panel button clicked');
                const twitchFloatingEnabled = document.getElementById('twitch_floating_panel_enabled');
                if (twitchFloatingEnabled) {
                    twitchFloatingEnabled.checked = false;
                    saveSettings();
                }
                sendMessageToContentScript('twitch_panel_hide');
            });
        }
    }

    /**
     * Обновление статуса Twitch подключения
     */
    function updateTwitchStatus(text, connected = false) {
        const statusElement = document.getElementById('twitch_status');
        if (statusElement) {
            statusElement.textContent = text;
            statusElement.style.color = connected ? '#9146FF' : '#666';
        }
    }
    
    // Обработчик для переключателя плеера (элемент может отсутствовать)
    const showMusicPlayer = document.getElementById('show_music_player');
    if (showMusicPlayer) showMusicPlayer.addEventListener('change', (e) => {
        const isEnabled = e.target.checked;
        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, {
                    type: 'toggleMusicPlayer',
                    enabled: isEnabled
                });
            }
        });
    });

    // Обработчики для модального окна
    const modal = document.getElementById('playlist_modal');
    const addPlaylistButton = document.getElementById('add_playlist');
    const cancelButton = document.getElementById('cancel_playlist');
    const saveButton = document.getElementById('save_playlist');
    const playlistInput = document.getElementById('modal_playlist_url');

    if (addPlaylistButton && modal) {
        addPlaylistButton.addEventListener('click', () => {
            modal.style.display = 'block';
        });
    }

    if (cancelButton && modal && playlistInput) {
        cancelButton.addEventListener('click', () => {
            modal.style.display = 'none';
            playlistInput.value = '';
        });
    }

    if (modal && playlistInput) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.style.display = 'none';
                playlistInput.value = '';
            }
        });
    }

    const playlistUrl = document.getElementById('playlist-url');
    if (playlistUrl) {
        playlistUrl.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                savePlaylist();
            }
        });
    }

    const savePlaylistBtn = document.getElementById('save-playlist');
    if (savePlaylistBtn) savePlaylistBtn.addEventListener('click', savePlaylist);

    function savePlaylist() {
        const url = document.getElementById('playlist-url').value.trim();
        const notification = document.getElementById('notification');
        
        if (!url) {
            showNotification('Пожалуйста, введите ссылку на плейлист', 'error');
            return;
        }
    
        if (!url.includes('spotify.com') && !url.includes('music.yandex')) {
            showNotification('Поддерживаются только Spotify и Яндекс.Музыка', 'error');
            return;
        }
    
        // Сохраняем URL и обновляем плеер
        chrome.storage.sync.set({ spotify_playlist_url: url }, () => {
            chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
                chrome.tabs.sendMessage(tabs[0].id, {
                    type: 'updatePlaylist',
                    url: url
                });
                showNotification('Плейлист успешно добавлен!', 'success');
                setTimeout(() => window.close(), 1500); // Закрываем попап через 1.5 секунды
            });
        });
    }

    function showNotification(message, type = 'success') {
        const notification = document.getElementById('notification');
        if (!notification) return; // Элемент может отсутствовать
        notification.textContent = message;
        notification.style.background = type === 'success' ? 'rgba(73, 191, 165, 0.1)' : 'rgba(239, 68, 68, 0.1)';
        notification.style.color = type === 'success' ? '#49BFA5' : '#ef4444';
        notification.classList.add('show');
        
        if (type === 'error') {
            setTimeout(() => notification.classList.remove('show'), 3000);
        }
    }

    // УДАЛИТЬ ВСЕ существующие обработчики для кнопок доджа и аватара
    // ДОБАВИТЬ этот новый код
    function setupButtons() {
        // Кнопка проверки доджа (элемент может отсутствовать)
        const checkDodge = document.getElementById('check_dodge');
        if (checkDodge) checkDodge.addEventListener('click', function() {
            console.log('Check dodge clicked');
            chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
                if (tabs[0]) {
                    chrome.tabs.sendMessage(tabs[0].id, { 
                        type: 'checkDodge',
                        timestamp: Date.now(),
                        draggable: true // Добавляем флаг для включения перетаскивания
                    });
                    setTimeout(() => window.close(), 100);
                }
            });
        });

        // Кнопка списка доджа
        const dodgeList = document.getElementById('dodge_list');
        if (dodgeList) dodgeList.addEventListener('click', function() {
            console.log('Dodge list clicked');
            chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
                if (tabs[0]) {
                    chrome.tabs.sendMessage(tabs[0].id, { 
                        type: 'showDodgeList',
                        timestamp: Date.now(),
                        draggable: true // Добавляем флаг для включения перетаскивания
                    });
                    setTimeout(() => window.close(), 100);
                }
            });
        });

        // Кнопка загрузки аватара
        const uploadAvatar = document.getElementById('upload_avatar');
        const avatarUpload = document.getElementById('avatar_upload');
        if (uploadAvatar && avatarUpload) {
            uploadAvatar.addEventListener('click', function() {
                avatarUpload.click();
            });

            avatarUpload.addEventListener('change', function(e) {
                const file = e.target.files[0];
                if (!file) return;

                const reader = new FileReader();
                reader.onload = function(event) {
                    const imageUrl = event.target.result;
                    chrome.storage.local.set({ savedAvatarUrl: imageUrl }, function() {
                        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
                            if (tabs[0]) {
                                chrome.tabs.sendMessage(tabs[0].id, {
                                    type: 'updateAvatar',
                                    imageUrl: imageUrl,
                                    timestamp: Date.now()
                                });
                                setTimeout(() => window.close(), 1000);
                            }
                        });
                    });
                };
                reader.readAsDataURL(file);
            });
        }
    }

    // Вызываем функцию настройки кнопок
    setupButtons();

    // Обработчики для модального окна плейлиста
    const addPlaylistBtn2 = document.getElementById('add_playlist');
    if (addPlaylistBtn2) addPlaylistBtn2.addEventListener('click', () => {
        const m = document.getElementById('playlist_modal');
        if (m) m.style.display = 'block';
    });

    const cancelPlaylistBtn2 = document.getElementById('cancel_playlist');
    if (cancelPlaylistBtn2) cancelPlaylistBtn2.addEventListener('click', () => {
        const m = document.getElementById('playlist_modal');
        if (m) m.style.display = 'none';
    });

    // УДАЛИТЬ этот блок кода - он вызывает ошибку
    // const playlistId = url.match(/playlist\/([a-zA-Z0-9]+)/)?.[1];
    // if (!playlistId) {
    //     alert('Неверная ссылка на плейлист Spotify');
    //     return;
    // }

    // Функции для обработки URL плейлистов
    function handleSpotifyUrl(url) {
        const spotifyPlaylistId = url.match(/playlist\/([a-zA-Z0-9]+)/)?.[1];
        if (!spotifyPlaylistId) return null;
        return { type: 'spotify', id: spotifyPlaylistId };
    }

    function handleYandexUrl(url) {
        const match = url.match(/users\/([^/]+)\/playlists\/(\d+)/);
        if (!match) return null;
        return { type: 'yandex', userId: match[1], id: match[2] };
    }

    function showNotification(message, type = 'success') {
        const notification = document.getElementById('notification');
        notification.textContent = message;
        notification.style.background = type === 'success' ? 'rgba(73, 191, 165, 0.1)' : 'rgba(239, 68, 68, 0.1)';
        notification.style.color = type === 'success' ? '#49BFA5' : '#ef4444';
        notification.classList.add('show');
        
        if (type === 'error') {
            setTimeout(() => notification.classList.remove('show'), 3000);
        }
    }

    // Обработчик сохранения плейлиста
    function savePlaylist() {
        const url = document.getElementById('playlist-url').value.trim();
        
        if (!url) {
            showNotification('Пожалуйста, введите ссылку на плейлист', 'error');
            return;
        }

        let playlistData = null;
        if (url.includes('spotify.com')) {
            playlistData = handleSpotifyUrl(url);
        } else if (url.includes('music.yandex')) {
            playlistData = handleYandexUrl(url);
        }

        if (!playlistData) {
            showNotification('Неверный формат ссылки', 'error');
            return;
        }

        // Сохраняем URL и обновляем плеер
        chrome.storage.sync.set({ 
            spotify_playlist_url: url,
            player_type: playlistData.type
        }, () => {
            chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
                chrome.tabs.sendMessage(tabs[0].id, {
                    type: 'updatePlaylist',
                    url: url,
                    playerData: playlistData
                });
                showNotification('Плейлист успешно добавлен!', 'success');
                setTimeout(() => {
                    document.getElementById('playlist_modal').style.display = 'none';
                }, 1500);
            });
        });
    }

    // Обработчики для кнопок доджа
    const checkDodge2 = document.getElementById('check_dodge');
    if (checkDodge2) checkDodge2.addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
            chrome.tabs.sendMessage(tab.id, { type: 'checkDodge' });
        }
    });

    const dodgeList2 = document.getElementById('dodge_list');
    if (dodgeList2) dodgeList2.addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
            chrome.tabs.sendMessage(tab.id, { type: 'showDodgeList' });
        }
    });

    // Добавить в DOMContentLoaded
    const uploadAvatar2 = document.getElementById('upload_avatar');
    const avatarUpload2 = document.getElementById('avatar_upload');
    if (uploadAvatar2 && avatarUpload2) uploadAvatar2.addEventListener('click', () => {
        avatarUpload2.click();
    });

    if (avatarUpload2) avatarUpload2.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const button = document.getElementById('upload_avatar');
        button.textContent = 'Обработка...';
        button.disabled = true;

        try {
            const img = new Image();
            img.src = URL.createObjectURL(file);
            await img.decode();

            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);

            const imageUrl = canvas.toDataURL('image/png');
            await chrome.storage.local.set({ savedAvatarUrl: imageUrl });

            // Отправляем в content script
            chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
                chrome.tabs.sendMessage(tabs[0].id, {
                    type: 'updateAvatar',
                    imageUrl: imageUrl
                });
            });

            // Уведомление об успехе
            const notification = document.createElement('div');
            notification.textContent = 'Аватар обновлен!';
            notification.style.cssText = `
                position: fixed;
                bottom: 20px;
                left: 50%;
                transform: translateX(-50%);
                background: #4CAF50;
                color: white;
                padding: 10px 20px;
                border-radius: 4px;
                animation: fadeOut 2s forwards 1s;
            `;
            document.body.appendChild(notification);
            setTimeout(() => notification.remove(), 3000);

        } catch (error) {
            console.error('Error processing image:', error);
            alert('Ошибка при обработке изображения. Попробуйте другое фото.');
        } finally {
            button.textContent = 'Загрузить фото';
            button.disabled = false;
        }
    });

    // Загружаем сохраненное состояние
    chrome.storage.sync.get(['modulesDisabled'], function(result) {
        const toggle = document.getElementById('disableModules');
        if (toggle) toggle.checked = result.modulesDisabled === true;
    });

    // Обработчик изменения состояния переключателя
    const disableModulesToggle = document.getElementById('disableModules');
    if (disableModulesToggle) disableModulesToggle.addEventListener('change', function(e) {
        const isDisabled = e.target.checked;
        
        // Сохраняем состояние
        chrome.storage.sync.set({ modulesDisabled: isDisabled }, () => {
            // Отправляем сообщение на все вкладки с polemicagame.com
            chrome.tabs.query({ url: '*://*.polemicagame.com/*' }, function(tabs) {
                for (let tab of tabs) {
                    chrome.tabs.sendMessage(tab.id, {
                        action: 'toggleModules',
                        isDisabled: isDisabled
                    });
                }
            });
        });
    });

    /**
     * Настройка обработчиков OBS
     */
    function setupOBSHandlers() {
        const obsEnabled = document.getElementById('obs_enabled');
        const obsSettings = document.getElementById('obs_settings');
        const obsConnect = document.getElementById('obs_connect');
        const obsDisconnect = document.getElementById('obs_disconnect');
        const obsHost = document.getElementById('obs_host');
        const obsPassword = document.getElementById('obs_password');
        const obsFloatingEnabled = document.getElementById('obs_floating_panel_enabled');
        const showFloatingPanel = document.getElementById('show_floating_panel');
        const hideFloatingPanel = document.getElementById('hide_floating_panel');

        // Переключатель включения OBS
        if (obsEnabled) {
            obsEnabled.addEventListener('change', async (e) => {
                const enabled = e.target.checked;
                obsSettings.style.display = enabled ? 'block' : 'none';
                
                if (!enabled) {
                    // Отключаем через background
                    await sendOBSCommand('disconnect');
                    updateOBSStatus('Не подключено', false);
                    updateScenesList([]);
                }
                
                saveSettings();
            });
        }

        // Кнопка подключения
        if (obsConnect) {
            obsConnect.addEventListener('click', async () => {
                const host = obsHost?.value || 'ws://localhost:4455';
                const password = obsPassword?.value || '';
                
                try {
                    obsConnect.disabled = true;
                    obsConnect.textContent = 'Подключение...';
                    updateOBSStatus('Подключение...', false);
                    
                    // Подключаемся через background
                    const result = await sendOBSCommand('connect', { url: host, password });
                    
                    if (result) {
                        updateOBSStatus('Подключено', true);
                        // Получаем актуальные сцены
                        const status = await sendOBSCommand('get_status');
                        if (status.scenes && status.scenes.length > 0) {
                            updateScenesList(status.scenes, status.currentScene);
                        }
                    }
                    
                    obsConnect.textContent = 'Подключиться';
                    saveSettings();
                    
                } catch (error) {
                    console.error('OBS connection failed:', error);
                    updateOBSStatus(`Ошибка: ${error.message}`, false);
                    obsConnect.textContent = 'Подключиться';
                } finally {
                    obsConnect.disabled = false;
                }
            });
        }

        // Кнопка отключения
        if (obsDisconnect) {
            obsDisconnect.addEventListener('click', async () => {
                try {
                    await sendOBSCommand('disconnect');
                    updateOBSStatus('Не подключено', false);
                    updateScenesList([]);
                } catch (error) {
                    console.error('Failed to disconnect:', error);
                }
            });
        }

        // Обработчики изменения настроек
        if (obsHost) {
            obsHost.addEventListener('change', saveSettings);
        }
        if (obsPassword) {
            obsPassword.addEventListener('change', saveSettings);
        }

        // Обработчик переключателя плавающей панели
        if (obsFloatingEnabled) {
            obsFloatingEnabled.addEventListener('change', saveSettings);
        }

        // Обработчик переключателя автоматического режима
        const obsAutoModeEnabled = document.getElementById('obs_auto_mode_enabled');
        const obsAutoSettings = document.getElementById('obs_auto_settings');
        if (obsAutoModeEnabled && obsAutoSettings) {
            obsAutoModeEnabled.addEventListener('change', (e) => {
                const enabled = e.target.checked;
                obsAutoSettings.style.display = enabled ? 'block' : 'none';
                saveSettings();
            });
        }

        // Обработчики выбора сцен
        const obsDayScene = document.getElementById('obs_day_scene');
        const obsNightScene = document.getElementById('obs_night_scene');
        if (obsDayScene) {
            obsDayScene.addEventListener('change', saveSettings);
        }
        if (obsNightScene) {
            obsNightScene.addEventListener('change', saveSettings);
        }

        // Кнопки управления плавающей панелью
        if (showFloatingPanel) {
            showFloatingPanel.addEventListener('click', () => {
                console.log('Show floating panel button clicked');
                // Включаем настройку и показываем панель
                const obsFloatingEnabled = document.getElementById('obs_floating_panel_enabled');
                if (obsFloatingEnabled) {
                    obsFloatingEnabled.checked = true;
                    saveSettings();
                }
                sendMessageToContentScript('floating_panel_show');
            });
        }

        if (hideFloatingPanel) {
            hideFloatingPanel.addEventListener('click', () => {
                console.log('Hide floating panel button clicked');
                // Отключаем настройку и скрываем панель
                const obsFloatingEnabled = document.getElementById('obs_floating_panel_enabled');
                if (obsFloatingEnabled) {
                    obsFloatingEnabled.checked = false;
                    saveSettings();
                }
                sendMessageToContentScript('floating_panel_hide');
            });
        }

        // Восстанавливаем состояние при загрузке popup
        restoreOBSState();
    }

    /**
     * Восстановление состояния OBS при открытии popup
     */
    async function restoreOBSState() {
        try {
            const status = await sendOBSCommand('get_status');
            
            if (status.connected) {
                updateOBSStatus('Подключено', true);
                if (status.scenes && status.scenes.length > 0) {
                    updateScenesList(status.scenes, status.currentScene);
                }
            } else {
                updateOBSStatus('Не подключено', false);
                updateScenesList([]);
            }
        } catch (error) {
            console.error('Failed to restore OBS state:', error);
            updateOBSStatus('Не подключено', false);
        }
    }

    /**
     * Отправка команды в background для управления OBS
     */
    async function sendOBSCommand(command, data = {}) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({
                type: 'obs_command',
                command: command,
                data: data
            }, (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else if (response && response.success) {
                    resolve(response.data);
                } else {
                    reject(new Error(response?.error || 'Unknown error'));
                }
            });
        });
    }

    /**
     * Обновление статуса подключения OBS
     * @param {string} status - Текст статуса
     * @param {boolean} connected - Состояние подключения
     */
    function updateOBSStatus(status, connected) {
        const statusElement = document.getElementById('obs_status');
        if (statusElement) {
            statusElement.textContent = status;
            statusElement.style.color = connected ? '#4CAF50' : '#666';
        }
    }

    /**
     * Обновление списка сцен
     * @param {Array} scenes - Массив сцен
     * @param {string} currentScene - Текущая активная сцена
     */
    function updateScenesList(scenes, currentScene) {
        const scenesList = document.getElementById('scenes_list');
        const obsDayScene = document.getElementById('obs_day_scene');
        const obsNightScene = document.getElementById('obs_night_scene');

        if (!scenesList) return;

        if (!scenes || scenes.length === 0) {
            scenesList.innerHTML = '<div style="padding: 10px; text-align: center; color: #999; font-size: 11px;">Нет доступных сцен</div>';
            // Очищаем выпадающие списки сцен
            if (obsDayScene) obsDayScene.innerHTML = '<option value="">Выберите сцену</option>';
            if (obsNightScene) obsNightScene.innerHTML = '<option value="">Выберите сцену</option>';
            return;
        }

        scenesList.innerHTML = scenes.map(scene => {
            const isActive = scene.sceneName === currentScene;
            return `
                <div class="scene-item ${isActive ? 'active' : ''}" 
                     data-scene="${scene.sceneName}"
                     style="
                         padding: 8px 12px; 
                         cursor: pointer; 
                         border-bottom: 1px solid #eee; 
                         font-size: 12px;
                         background: ${isActive ? '#e3f2fd' : 'white'};
                         color: ${isActive ? '#1976d2' : '#333'};
                         font-weight: ${isActive ? 'bold' : 'normal'};
                     "
                     onmouseover="this.style.background='#f5f5f5'"
                     onmouseout="this.style.background='${isActive ? '#e3f2fd' : 'white'}'"
                >
                    ${scene.sceneName}
                    ${isActive ? ' (активная)' : ''}
                </div>
            `;
        }).join('');

        // Добавляем обработчики клика по сценам
        scenesList.querySelectorAll('.scene-item').forEach(item => {
            item.addEventListener('click', async () => {
                const sceneName = item.dataset.scene;

                try {
                    // Переключаем сцену через background
                    await sendOBSCommand('set_scene', { sceneName });
                    updateCurrentSceneHighlight(sceneName);
                } catch (error) {
                    console.error('Failed to switch scene:', error);
                    updateOBSStatus(`Ошибка смены сцены: ${error.message}`, true);
                }
            });
        });

        // Заполняем выпадающие списки сцен для автоматического режима
        const sceneOptions = '<option value="">Выберите сцену</option>' +
            scenes.map(scene => `<option value="${scene.sceneName}">${scene.sceneName}</option>`).join('');

        if (obsDayScene) {
            obsDayScene.innerHTML = sceneOptions;
            // Восстанавливаем сохраненное значение
            chrome.storage.sync.get(['obs_day_scene'], (result) => {
                if (result.obs_day_scene) {
                    obsDayScene.value = result.obs_day_scene;
                }
            });
        }

        if (obsNightScene) {
            obsNightScene.innerHTML = sceneOptions;
            // Восстанавливаем сохраненное значение
            chrome.storage.sync.get(['obs_night_scene'], (result) => {
                if (result.obs_night_scene) {
                    obsNightScene.value = result.obs_night_scene;
                }
            });
        }
    }

    /**
     * Обновление подсветки текущей сцены
     * @param {string} sceneName - Название активной сцены
     */
    function updateCurrentSceneHighlight(sceneName) {
        const scenesList = document.getElementById('scenes_list');
        if (!scenesList) return;

        // Убираем выделение со всех сцен
        scenesList.querySelectorAll('.scene-item').forEach(item => {
            const isActive = item.dataset.scene === sceneName;
            item.style.background = isActive ? '#e3f2fd' : 'white';
            item.style.color = isActive ? '#1976d2' : '#333';
            item.style.fontWeight = isActive ? 'bold' : 'normal';
            
            // Обновляем текст
            const baseName = item.dataset.scene;
            item.textContent = baseName + (isActive ? ' (активная)' : '');
            
            item.onmouseout = () => {
                item.style.background = isActive ? '#e3f2fd' : 'white';
            };
        });
    }
});
