(function() {
    console.log("PLAYER NOTES SCRIPT LOADED!");

    class NotesManager {
        constructor() {
            console.log('Initializing NotesManager');
            this.VERSION = '1.0';
            this.notes = {};
            this.playerStats = new Map();
            // Сет скрытых видео по username (в пределах сессии)
            this.hiddenVideos = new Set();
            this.settings = {
                show_mmr: true,
                show_games: true,
                show_id: false,
                show_winrate: true,
                show_kills: true,
                show_roles: true,
                disable_webcam_clicks: false,
                statistics_enabled: true,
                stats_button_theme: 'default',
                auto_hide_roles_enabled: false
            };

            chrome.storage.sync.get({
                notes: {},
                version: this.VERSION,
                show_mmr: true,
                show_games: true,
                show_id: false,
                show_winrate: true,
                show_kills: true,
                show_roles: true,
                disable_webcam_clicks: false,
                statistics_enabled: true,
                stats_button_theme: 'default',
                auto_hide_roles_enabled: false
            }, (result) => {
                this.notes = result.notes;
                this.settings.show_mmr = result.show_mmr;
                this.settings.show_games = result.show_games;
                this.settings.show_id = result.show_id;
                this.settings.show_winrate = result.show_winrate;
                this.settings.show_kills = result.show_kills;
                this.settings.show_roles = result.show_roles;
                this.settings.disable_webcam_clicks = result.disable_webcam_clicks;
                this.settings.statistics_enabled = result.statistics_enabled !== false;
                this.settings.stats_button_theme = result.stats_button_theme || 'default';
                this.settings.auto_hide_roles_enabled = result.auto_hide_roles_enabled === true;
                console.log('Notes loaded:', this.notes);
                this.addedElements = new Set();
                this.init();
            });

            this.roleSpriteBaseUrl = null;

            this.loadNotes()
                .then(() => this.init())
                .catch(error => console.error('Error initializing:', error));

            this.setupMutationObserver();
            this.updateAllPlayers();
            this.setupStateChangeHandler();
            this.setupPeriodicCheck();
            
            // Проверяем сохраненное состояние активации
            chrome.storage.local.get('scriptActivated', (data) => {
                // Если скрипт еще не был активирован или явно установлен как активный
                if (data.scriptActivated !== false) {
                    this.activateScript();
                    // Сохраняем состояние активации
                    chrome.storage.local.set({ scriptActivated: true });
                }
            });
            this.setupStatisticsChecker();

            this.setupDayNightObserver();
            this.addMatchPageStyles();

            this.loadSavedAvatar();
            this.setupAvatarObserver();

            // Устанавливаем защиту от кликов по веб-камере судей (захватывающий обработчик)
            this.setupWebcamClickGuard();

            chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
                if (message.type === 'updateAvatar') {
                    const avatarImg = document.querySelector('.p-play__profile-img');
                    if (avatarImg) {
                        avatarImg.src = message.imageUrl;
                    }
                }

                // Применяем обновления настроек из попапа (например, show_id)
                if (message.type === 'updateNotesSettings' && message.settings) {
                    this.settings = { ...this.settings, ...message.settings };
                    if (this.settings.statistics_enabled === false) {
                        this.removeStatisticsElements();
                    } else {
                        this.applyStatsButtonTheme();
                        this.updateAllPlayers();
                    }
                    // Перестраиваем подсказки под новые настройки
                    this.updateAllTooltips();
                }
            });

            // Добавляем автоматическую проверку при загрузке
            this.checkGameState();
            
            // Настраиваем периодическую проверку
            setInterval(() => this.checkGameState(), 5000);
            
            // Наблюдаем за изменениями DOM
            const observer = new MutationObserver(() => this.checkGameState());
            observer.observe(document.body, {
                childList: true,
                subtree: true
            });

            this.setupMatchPageHandler();
            this.setupSlotChangeObserver();

            // Добавляем автоматическое нажатие D при загрузке
            this.autoHideRoles();
        }

        async init() {
            this.loadNotes();
            this.loadSettings();
            this.setupMutationObserver();
            this.setupStateChangeHandler();
            this.setupPeriodicCheck();
            
            // Дополнительные обработчики
            this.addMatchPageStyles();
            this.loadSavedAvatar();
            this.setupAvatarObserver();
            this.setupSlotChangeObserver();
            this.setupWebcamClickGuard();
            this.checkGameState();
            this.setupMatchPageHandler();
            this.processExistingElements();
        }

        async loadNotes() {
            return new Promise((resolve) => {
                chrome.storage.sync.get({
                    notes: {},
                    version: this.VERSION
                }, (result) => {
                    this.notes = result.notes;
                    console.log('Notes loaded:', this.notes);
                    resolve();
                });
            });
        }

        async saveNote(playerId, text) {
            this.notes[playerId] = {
                text: text,
                timestamp: Date.now()
            };
            try {
                await chrome.storage.sync.set({ playerNotes: this.notes });
                console.log('Note saved for player:', playerId);
            } catch (error) {
                console.error('Error saving note:', error);
            }
        }

        getNoteForPlayer(playerId) {
            return this.notes[playerId]?.text || '';
        }

        async loadPlayerStats(username) {
            if (this.settings.statistics_enabled === false) {
                return;
            }

            try {
                // Используем новый API для получения списка игр
                const response = await fetch('https://game.polemicagame.com/api/games');
                const games = await response.json();
                
                // Ищем игрока во всех активных играх
                let player = null;
                for (const game of games) {
                    const foundPlayer = game.players.find(p => p.username.toLowerCase() === username.toLowerCase());
                    if (foundPlayer) {
                        player = foundPlayer;
                        break;
                    }
                }

                if (!player) {
                    console.log(`Player ${username} not found in active games`);
                    return;
                }

                const userId = player.id;
                
                // Используем существующие API для остальной статистики
                let [generalStats, roleStats, killcount] = await Promise.all([
                    fetch(`https://polemicagame.com/profile/default/get-role-statistic?user_id=${userId}&role=&game_type=league&scoring_type=scoring_2%2Cscoring_3`).then(r => r.json()),
                    fetch(`https://polemicagame.com/profile/default/get-statistic?user_id=${userId}&game_type=league&scoring_type=scoring_2%2Cscoring_3`).then(r => r.json()),
                    fetch(`https://polemicagame.com/profile/default/get-role-statistic?user_id=${userId}&role=civilian%2Csheriff&game_type=league&scoring_type=scoring_2%2Cscoring_3`).then(r => r.json()),
                ]);

                console.log('Raw general stats:', generalStats);
                console.log('Raw role stats:', roleStats);

                // Получаем общую статистику из первого элемента массива
                const generalData = generalStats[0] || {};
                const killcounter = killcount[0] || {};

                const calculateWinrate = (wins, total) => {
                    wins = Number(wins) || 0;
                    total = Number(total) || 0;
                    if (total === 0) return '0.0';
                    return ((wins / total) * 100).toFixed(1);
                };

                this.playerStats.set(username.toLowerCase(), {
                    mmr: player.mmr || '???',
                    totalGames: Number(generalData.games_count) || '?',
                    id: player.id,
                    generalStats: {
                        gamesCount: Number(generalData.games_count) || 0,
                        winsCount: Number(generalData.wins_count) || 0,
                        firstKilledCount: Number(killcounter.first_killed_count) || 0,
                        killpercent: Number(Math.trunc((killcounter.first_killed_count/killcounter.games_count)*100)) || 0,
                        winrate: calculateWinrate(generalData.wins_count, generalData.games_count)
                    },
                    roleStats: {
                        civilian: {
                            winrate: calculateWinrate(roleStats.civilian.wins_count, roleStats.civilian.games_count)
                        },
                        sheriff: {
                            winrate: calculateWinrate(roleStats.sheriff.wins_count, roleStats.sheriff.games_count)
                        },
                        mafia: {
                            winrate: calculateWinrate(roleStats.mafia.wins_count, roleStats.mafia.games_count)
                        },
                        godfather: {
                            winrate: calculateWinrate(roleStats.godfather.wins_count, roleStats.godfather.games_count)
                        }
                    }
                });

                console.log('Processed stats:', this.playerStats.get(username.toLowerCase()));

                const existingTooltip = document.querySelector(`.stats-button[data-username="${username}"] .tooltip`);
                if (existingTooltip) {
                    existingTooltip.innerHTML = this.generateTooltipContent(username);
                }

            } catch (error) {
                console.error(`Error loading stats for player ${username}:`, error);
            }
        }

        createStatsButton(username) {
            if (this.settings.statistics_enabled === false) {
                return null;
            }

            const themeColor = this.getStatsThemeColor();
            const statsButton = document.createElement('div');
            statsButton.className = 'stats-button';
            statsButton.dataset.username = username;
            // Стили позиционирования управляются через notes.css, чтобы иконки
            // были привязаны к .player__info и не зависели от разрешения/масштаба
            statsButton.style.cssText = `
                border: none;
                border-radius: 50%;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 1000;
                opacity: 1 !important;
                visibility: visible !important;
            `;

            // Добавляем класс для медиа-запросов
            statsButton.classList.add('stats-button');

            // Добавляем обработчик клика для открытия профиля
            statsButton.addEventListener('click', async (e) => {
                e.stopPropagation();
                // Получаем ID из сохраненных данных статистики
                const playerStats = this.playerStats.get(username.toLowerCase());
                if (playerStats && playerStats.id) {
                    window.open(`https://polemicagame.com/profile/${playerStats.id}`, '_blank');
                } else {
                    // Если ID еще не загружен, сначала загрузим статистику
                    try {
                        const response = await fetch('https://polemicagame.com/rating/get-list?limit=1000');
                        const players = await response.json();
                        const player = players.find(p => p.username.toLowerCase() === username.toLowerCase());
                        if (player) {
                            window.open(`https://polemicagame.com/profile/${player.user_id}`, '_blank');
                        }
                    } catch (error) {
                        console.error('Error loading player ID:', error);
                    }
                }
            });

            statsButton.innerHTML = `
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${themeColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 3v18h18" />
                    <path d="M18 9l-5 5-2-2-4 4" />
                    <path d="M18 9h-6" />
                    <path d="M18 9v6" />
                </svg>
            `;

            const tooltip = this.createTooltip(username);
            statsButton.appendChild(tooltip);

            statsButton.addEventListener('mouseenter', () => {
                const svg = statsButton.querySelector('svg');
                svg.style.stroke = themeColor;
                tooltip.style.visibility = 'visible';
                tooltip.style.opacity = '1';
                tooltip.style.transform = 'translateY(0)';
            });

            statsButton.addEventListener('mouseleave', () => {
                const svg = statsButton.querySelector('svg');
                svg.style.stroke = themeColor;
                tooltip.style.visibility = 'hidden';
                tooltip.style.opacity = '0';
                tooltip.style.transform = 'translateY(10px)';
            });

            this.applyButtonTheme(statsButton);
            return statsButton;
        }
        
        injectNotesManually() {
            // Сохраняем текущую статистику
            const currentStats = { ...this.playerStats.get(this.playerStats.keys().next().value) };
            
            // Ищем всех игроков, включая тех, кто убит или скрыт ночью
            const playerContainers = document.querySelectorAll('.player.desktop-version:not(.judge-player), .player.desktop-version.hidden:not(.judge-player)');
        
            playerContainers.forEach(container => {
                const nicknameElement = container.querySelector('.player__info .info__name');
                const videoWrapper = container.querySelector('.player__video-wrapper');
                const infoContainer = container.querySelector('.player__info');
        
                if (nicknameElement && infoContainer && videoWrapper) {
                    const username = nicknameElement.textContent.trim();
                    if (!username) return;

                    // Обеспечиваем контейнер для иконок
                    let iconsGroup = infoContainer.querySelector('.player-icons');
                    if (!iconsGroup) {
                        iconsGroup = document.createElement('div');
                        iconsGroup.className = 'player-icons';
                        infoContainer.appendChild(iconsGroup);
                    }

                    const existingButton = iconsGroup.querySelector(`.stats-button[data-username="${username}"]`);
                    const existingNoteButton = iconsGroup.querySelector(`.note-button[data-username="${username}"]`);

                    if (!existingButton || !existingNoteButton) {
                        // Используем сохраненную статистику
                        if (this.playerStats.has(username.toLowerCase())) {
                            this.playerStats.set(username.toLowerCase(), currentStats);
                        }

                        // Добавляем кнопки только если их нет
                        if (!existingButton) {
                            const statsButton = this.createStatsButton(username);
                            // Делаем кнопку видимой даже при скрытой веб-камере
                            if (statsButton) {
                            statsButton.style.opacity = '1';
                            statsButton.style.visibility = 'visible';
                            // Привязываем к .player__info, чтобы иконки были над блоком информации
                            iconsGroup.appendChild(statsButton);
                            }
                        }

                        if (!existingNoteButton) {
                            const noteButton = this.createNoteButton(username);
                            // Размещаем рядом со статистикой внутри .player-icons
                            iconsGroup.appendChild(noteButton);
                        }

                        // Добавляем кнопку последних игр, если отсутствует
                        if (!iconsGroup.querySelector(`.last-games-button[data-username="${username}"]`)) {
                            const lastGamesButton = this.createLastGamesButton(username);
                            iconsGroup.appendChild(lastGamesButton);
                        }
                    }

                    // Убеждаемся, что кнопки всегда видны
                    if (existingButton) {
                        existingButton.style.opacity = '1';
                        existingButton.style.visibility = 'visible';
                    }
                }
            });
        }

        createNoteButton(username) {
            const noteButton = document.createElement('button');
            noteButton.className = 'note-button';
            noteButton.dataset.username = username;
            noteButton.title = `Заметка для игрока ${username}`;
            // Позиционирование и размеры задаются в notes.css (якорь: .player__info)
            noteButton.style.cssText = `
                background: none;
                border: none;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 1000;
                transition: all 0.2s ease;
                opacity: 1 !important;
                visibility: visible !important;
            `;

            noteButton.innerHTML = `
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="color: rgba(66, 103, 178, 0.9);">
                    <path d="M19 3H5C3.89543 3 3 3.89543 3 5V19C3 20.1046 3.89543 21 5 21H19C20.1046 21 21 20.1046 21 19V5C21 3.89543 20.1046 3 19 3Z" 
                        stroke="currentColor" 
                        stroke-width="2" 
                        stroke-linecap="round" 
                        stroke-linejoin="round"/>
                    <path d="M8 12L16 12M8 8L16 8M8 16L13 16" 
                        stroke="currentColor" 
                        stroke-width="2" 
                        stroke-linecap="round" 
                        stroke-linejoin="round"/>
                </svg>
            `;

            // Добавляем обработчик клика
            noteButton.addEventListener('click', () => {
                this.showNoteModal(username);
            });

            this.applyButtonTheme(noteButton);
            return noteButton;
        }

        getButtonStyle() {
            return `
                background: rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(4px);
                border: 1px solid rgba(99, 102, 241, 0.3);
                border-radius: 6px;
                cursor: pointer;
                position: static;
                margin: 0 0 0 5px;
                padding: 4px;
                display: flex;
                align-items: center;
                justify-content: center;
                width: 24px;
                height: -24px;
                transition: all 0.2s ease;
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            `;
        }

        addHoverEffects(button) {
            button.addEventListener('mouseenter', () => {
                button.style.transform = 'scale(1.1)';
                button.style.boxShadow = '0 4px 8px rgba(99, 102, 241, 0.2)';
                button.style.background = 'rgba(255, 255, 255, 0.2)';
            });

            button.addEventListener('mouseleave', () => {
                button.style.transform = 'scale(1)';
                button.style.boxShadow = '0 2px 4px rgba(0, 0, 0, 0.1)';
                button.style.background = 'rgba(255, 255, 255, 0.1)';
            });
        }

        showNoteModal(username) {
            const modal = document.createElement('div');
            modal.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: rgba(11, 27, 57, 0.95);
                padding: 20px;
                border-radius: 8px;
                z-index: 10000;
                min-width: 300px;
                border: 1px solid rgba(79, 129, 245, 0.3);
                box-shadow: 0 0 20px rgba(0, 0, 0, 0.5);
            `;

            const title = document.createElement('h3');
            title.textContent = `Заметка для игрока ${username}`;
            title.style.cssText = `
                margin: 0 0 15px 0;
                color: white;
                font-size: 16px;
            `;

            const textarea = document.createElement('textarea');
            const note = this.notes[username];
            textarea.value = note ? (typeof note === 'string' ? note : note.text) : '';
            textarea.style.cssText = `
                width: 100%;
                min-height: 100px;
                margin-bottom: 15px;
                background: rgba(255, 255, 255, 0.1);
                border: 1px solid rgba(255, 255, 255, 0.2);
                border-radius: 4px;
                color: white;
                padding: 8px;
                resize: vertical;
            `;

            const saveButton = document.createElement('button');
            saveButton.textContent = 'Сохранить';
            saveButton.style.cssText = `
                padding: 8px 16px;
                background: rgba(99, 102, 241, 0.3);
                color: white;
                border: none;
                border-radius: 8px;
                cursor: pointer;
            `;

            saveButton.addEventListener('click', () => {
                if (textarea.value.trim()) {
                    this.notes[username] = {
                        text: textarea.value.trim(),
                        timestamp: Date.now(),
                        version: this.VERSION
                    };
                } else {
                    delete this.notes[username];
                }
                this.saveNotes();
                document.body.removeChild(modal);
                const tooltip = document.querySelector(`.stats-button[data-username="${username}"] .tooltip`);
                if (tooltip) {
                    tooltip.innerHTML = this.generateTooltipContent(username);
                }
            });

            modal.appendChild(title);
            modal.appendChild(textarea);
            modal.appendChild(saveButton);

            document.body.appendChild(modal);
        }

        async loadSettings() {
            const result = await chrome.storage.sync.get({
                show_mmr: true,
                show_games: true,
                show_id: false,
                show_winrate: true,
                show_kills: true,
                show_roles: true,
                disable_webcam_clicks: false,
                statistics_enabled: true,
                stats_button_theme: 'default',
                auto_hide_roles_enabled: false
            });
            this.settings = result;
        }

        setupWebcamClickGuard() {
            if (this._webcamGuardInstalled) return;
            this._webcamGuardInstalled = true;
            document.addEventListener('click', (e) => {
                try {
                    if (!this.settings.disable_webcam_clicks) return;
                    const isWebcamArea = e.target.closest && e.target.closest('.player__video-wrapper, .player__video, .button.preset-1.small.desktop-version, .video-control');
                    if (isWebcamArea) {
                        e.stopImmediatePropagation();
                        e.stopPropagation();
                        e.preventDefault();
                        // Опционально: визуальная подсказка
                        // console.log('⛔ Блокирован клик по веб-камере судьи');
                    }
                } catch (_) { /* no-op */ }
            }, true); // capture phase
        }

        updateAllTooltips() {
            const tooltips = document.querySelectorAll('.stats-button .tooltip');
            tooltips.forEach(tooltip => {
                const username = tooltip.closest('.stats-button').dataset.username;
                if (username && this.playerStats.has(username.toLowerCase())) {
                    tooltip.innerHTML = this.generateTooltipContent(username);
                }
            });
        }

        removeStatisticsElements() {
            document.querySelectorAll(
                '.stats-button, .note-button, .last-games-button, .hide-video-button, .player-stats'
            ).forEach(el => el.remove());
            document.querySelectorAll('.player-icons').forEach((group) => {
                if (!group.children.length) group.remove();
            });
        }

        getStatsThemeColor() {
            const colors = {
                default: 'rgb(66, 103, 178)',
                pink: '#ec4899',
                yellow: '#eab308',
                red: '#ef4444',
                green: '#22c55e',
                lime: '#84cc16',
                blue: '#38bdf8'
            };
            return colors[this.settings.stats_button_theme] || colors.default;
        }

        applyButtonTheme(button) {
            if (!button) return;
            const color = this.getStatsThemeColor();
            button.style.setProperty('--stats-button-theme-color', color);
            button.style.color = color;
            button.style.borderColor = color;
            button.style.background = 'transparent';
            button.querySelectorAll('svg').forEach((svg) => {
                svg.style.color = color;
                svg.style.setProperty('stroke', color, 'important');
            });
            button.querySelectorAll('path, circle, line, polyline').forEach((node) => {
                if (node.getAttribute('stroke') || node.getAttribute('stroke') === 'currentColor') {
                    node.setAttribute('stroke', color);
                    node.style.setProperty('stroke', color, 'important');
                }
            });
        }

        applyStatsButtonTheme() {
            document.querySelectorAll('.stats-button, .note-button, .last-games-button, .hide-video-button').forEach((button) => {
                this.applyButtonTheme(button);
            });
        }

        generateTooltipContent(username) {
            const stats = this.playerStats.get(username.toLowerCase()) || {
                mmr: '???',
                totalGames: '?',
                id: '?',
                generalStats: {
                    winrate: '?',
                    firstKilledCount: '?',
                    killpercent: '?'
                },
                roleStats: {
                    civilian: { winrate: '?' },
                    sheriff: { winrate: '?' },
                    mafia: { winrate: '?' },
                    godfather: { winrate: '?' }
                }
            };

            const noteText = this.notes[username]?.text || 'Нет заметок';
            
            let tooltipContent = `<div class="tooltip-text" style="margin-bottom: 6px; font-size: 11px;">${noteText}</div>`;
            tooltipContent += `<div class="tooltip-text" style="font-size: 10px;">`;
            
            if (this.settings.show_mmr) {
                tooltipContent += `MMR: ${stats.mmr}<br>`;
            }
            
            if (this.settings.show_games) {
                tooltipContent += `Игр: ${stats.totalGames}<br>`;
            }
            
            if (this.settings.show_id) {
                tooltipContent += `ID: ${stats.id}<br>`;
            }
            
            if (this.settings.show_winrate) {
                tooltipContent += `WR: ${stats.generalStats.winrate}%<br>`;
            }
            
            if (this.settings.show_kills) {
                tooltipContent += `Отстрелы: ${stats.generalStats.firstKilledCount} (${stats.generalStats.killpercent}%)<br>`;
            }
            
            if (this.settings.show_roles) {
                tooltipContent +=
                    `<div class="tooltip-text" style="margin-top: 4px; font-size: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 4px;">` +
                    `<span style="display: flex; align-items: center; gap: 2px;"><span style="color: #fff;">${this.createRoleSvg('civilian', 12)}</span> ${stats.roleStats.civilian.winrate}%</span>` +
                    `<span style="display: flex; align-items: center; gap: 2px;"><span style="color: #fff;">${this.createRoleSvg('sheriff', 12)}</span> ${stats.roleStats.sheriff.winrate}%</span>` +
                    `<span style="display: flex; align-items: center; gap: 2px;"><span style="color: #fff;">${this.createRoleSvg('mafia', 12)}</span> ${stats.roleStats.mafia.winrate}%</span>` +
                    `<span style="display: flex; align-items: center; gap: 2px;"><span style="color: #fff;">${this.createRoleSvg('godfather', 12)}</span> ${stats.roleStats.godfather.winrate}%</span>` +
                    `</div>`;
            }

            tooltipContent += '</div>';
            return tooltipContent;
        }

        createTooltip(username) {
            // Загружаем статистику, если её ещё нет
            if (!this.playerStats.has(username.toLowerCase())) {
                this.loadPlayerStats(username);
            }

            const tooltip = document.createElement('div');
            tooltip.className = 'tooltip';
            tooltip.style.cssText = `
                position: absolute;
                bottom: 100%;
                left: 0;
                transform: translateY(10px);
                background: rgba(11, 27, 57, 0.9);
                backdrop-filter: blur(8px);
                border: 1px solid rgba(79, 129, 245, 0.3);
                padding: 10px;
                border-radius: 8px;
                font-size: 12px;
                visibility: hidden;
                opacity: 0;
                transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                pointer-events: none;
                white-space: normal;
                min-width: 120px;
                z-index: 1001;
                line-height: 1.3;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
                margin-bottom: 5px;
                color: white;
            `;

            tooltip.innerHTML = this.generateTooltipContent(username);
            return tooltip;
        }

        setupStatisticsChecker() {
            // Проверяем каждые 5 секунд
                setInterval(() => {
                if (this.settings.statistics_enabled === false) {
                    this.removeStatisticsElements();
                    return;
                }

                // Проверяем, что мы в игре (есть элементы игроков)
                const playersExist = document.querySelectorAll('.player').length > 0;
                // Проверяем, что статистика отсутствует
                const statsExist = document.querySelectorAll('.player-stats').length > 0;
                
                if (playersExist && !statsExist) {
                    console.log('Game active but statistics missing, reactivating...');
                    // Очищаем старые элементы статистики если они есть
                    document.querySelectorAll('.player-stats').forEach(el => el.remove());
                    
                    // Переактивируем статистику
                    this.activateScript();
                    
                    // Обновляем всех игроков
                    this.updateAllPlayers();
                }
                }, 5000);
            }
        setupMutationObserver() {
            const observer = new MutationObserver((mutations) => {
                // Обрабатываем добавление новых элементов
                for (const mutation of mutations) {
                    if (mutation.addedNodes.length) {
                        mutation.addedNodes.forEach(node => {
                            if (node.nodeType === 1) { // Проверяем, что это элемент DOM
                                // Проверяем, есть ли новые игроки
                                const players = node.querySelectorAll ? node.querySelectorAll('.player') : [];
                                players.forEach(player => this.processElement(player));
                                
                                // Если добавлен сам элемент player
                                if (node.classList && node.classList.contains('player')) {
                                    this.processElement(node);
                                }
                            }
                        });
                    }
                }
            });

            observer.observe(document.body, { 
                childList: true, 
                subtree: true 
            });
        }

        setupStateChangeHandler() {
            // Наблюдатель за изменениями состояния игры
            const gameObserver = new MutationObserver(() => {
                setTimeout(() => this.updateAllPlayers(), 100);
            });

            const gameElement = document.querySelector('.game');
            if (gameElement) {
                gameObserver.observe(gameElement, {
                    attributes: true,
                    attributeFilter: ['class'],
                    subtree: true
                });
            }
        }

        setupPeriodicCheck() {
            // Проверяем каждую секунду
            setInterval(() => {
                if (this.settings.statistics_enabled === false) {
                    this.removeStatisticsElements();
                    return;
                }

                const players = document.querySelectorAll('.player');
                players.forEach(player => {
                    if (!player.querySelector('.player-stats')) {
                        this.updatePlayer(player);
                    }
                });
            }, 1000);
        }

        async updatePlayer(playerElement) {
            if (this.settings.statistics_enabled === false) {
                this.removeStatisticsElements();
                return;
            }

            if (!playerElement || !playerElement.classList.contains('player')) return;

            const playerId = playerElement.getAttribute('data-id');
            if (!playerId) return;

            // Проверяем наличие контейнера для статистики
            let statsContainer = playerElement.querySelector('.player-stats');
            if (!statsContainer) {
                statsContainer = document.createElement('div');
                statsContainer.className = 'player-stats';
                statsContainer.style.cssText = `
                    font-size: 12px;
                    color: rgba(255, 255, 255, 0.7);
                    margin-top: 4px;
                    position: relative;
                    z-index: 100000;
                    pointer-events: auto;
                    display: block !important;
                    opacity: 1 !important;
                    background: rgba(0, 0, 0, 0.5);
                    padding: 2px 4px;
                    border-radius: 4px;
                `;

                // Добавляем контейнер в правильное место
                const info = playerElement.querySelector('.info__name');
                if (info) {
                    info.appendChild(statsContainer);
                } else {
                    playerElement.appendChild(statsContainer);
                }
            }

            // Получаем или загружаем статистику
            let stats = this.playerStats.get(playerId);
            if (!stats) {
                try {
                    const response = await fetch(`https://polemicagame.com/profile/get-stats?userId=${playerId}`);
                    stats = await response.json();
                    this.playerStats.set(playerId, stats);
                } catch (error) {
                    console.error('Error fetching stats:', error);
                    return;
                }
            }

            // Обновляем отображение
            const settings = await chrome.storage.sync.get({
                show_mmr: true,
                show_games: true,
                show_winrate: true,
                show_kills: true,
                show_roles: true
            });

            let statsHtml = '';
            if (settings.show_mmr && stats.mmr) {
                statsHtml += `MMR: ${stats.mmr} `;
            }
            if (settings.show_games && stats.games_count) {
                statsHtml += `Игр: ${stats.games_count} `;
            }
            if (settings.show_winrate && stats.games_count) {
                const winrate = ((stats.wins_count / stats.games_count) * 100).toFixed(1);
                statsHtml += `WR: ${winrate}% `;
            }
            if (settings.show_kills && stats.kills) {
                statsHtml += `Убийств: ${stats.kills} `;
            }
            if (settings.show_roles && stats.roles) {
                statsHtml += '<br>Роли: ';
                for (const role in stats.roles) {
                    const percentage = ((stats.roles[role] / stats.games_count) * 100).toFixed(1);
                    statsHtml += `${role}: ${percentage}% `;
                }
            }

            statsContainer.innerHTML = statsHtml;
        }

        updateAllPlayers() {
            if (this.settings.statistics_enabled === false) {
                this.removeStatisticsElements();
                return;
            }

            const players = document.querySelectorAll('.player');
            players.forEach(player => this.updatePlayer(player));
        }

        saveNotes() {
            chrome.storage.sync.set({ 
                notes: this.notes,
                version: this.VERSION 
            }, () => {
                if (chrome.runtime.lastError) {
                    console.error('Error saving notes:', chrome.runtime.lastError);
                } else {
                    console.log('Notes saved successfully');
                }
            });
        }

        // Добавляем метод активации скрипта
        activateScript() {
            if (this.scriptActivated) {
                // Проверяем, действительно ли статистика отображается
                const statsExist = document.querySelectorAll('.player-stats').length > 0;
                if (statsExist) {
                    console.log('Script already activated and statistics are visible');
                    return;
                }
                console.log('Script activated but statistics missing, reactivating...');
            }
            
            try {
                console.log('Activating script...');
                this.processExistingElements();
                this.setupMutationObserver();
                this.scriptActivated = true;
                chrome.storage.local.set({ scriptActivated: true });
                console.log('Script activated successfully');
            } catch (error) {
                console.error('Error activating script:', error);
                setTimeout(() => this.activateScript(), 2000);
            }
        }

        setupDayNightObserver() {
            // Наблюдаем за изменениями классов body для отслеживания смены дня/ночи
            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                        // Проверяем изменение классов day/night
                        const isDayChange = mutation.target.classList.contains('day') || 
                                          mutation.target.classList.contains('night');
                        
                        if (isDayChange) {
                            console.log('Day/Night changed, reactivating statistics...');
                            // Даем небольшую задержку для обновления DOM
                setTimeout(() => {
                                this.reactivateStatistics();
                }, 1000);
                        }
                    }
                });
            });

            // Начинаем наблюдение за body
            observer.observe(document.body, {
                attributes: true,
                attributeFilter: ['class']
            });
        }

        reactivateStatistics() {
            // Очищаем старые элементы статистики
            document.querySelectorAll('.player-stats').forEach(el => el.remove());
            
            // Переактивируем статистику
            this.activateScript();
            
            // Обновляем всех игроков
            this.updateAllPlayers();
            
            console.log('Statistics reactivated after day/night change');
        }

        processExistingElements() {
            try {
                const elements = document.querySelectorAll('.player');
                elements.forEach(element => this.processElement(element));
            } catch (error) {
                console.error('Error processing elements:', error);
            }
        }

        addMatchPageStyles() {
            const style = document.createElement('style');
            style.textContent = `
                /* Скрываем стопы на странице матча */
                body[data-page-type="match"] .player__role use[href$="#stop"],
                body[data-page-type="match"] .player__role use[href*="#stop"],
                body[data-page-type="match"] svg use[href$="#stop"],
                body[data-page-type="match"] svg use[href*="#stop"] {
                    display: none !important;
                }
                
                /* Скрываем родительские SVG если в них только стоп */
                body[data-page-type="match"] .player__role svg:has(use[href$="#stop"]),
                body[data-page-type="match"] .player__role svg:has(use[href*="#stop"]) {
                    display: none !important;
                }
            `;
            document.head.appendChild(style);

            // Добавляем атрибут для определения страницы матча
            if (window.location.pathname.includes('/match/')) {
                document.body.setAttribute('data-page-type', 'match');
            }
        }

        async loadSavedAvatar() {
            try {
                const data = await chrome.storage.local.get('savedAvatarUrl');
                if (data.savedAvatarUrl) {
                    // Обновляем аватар в игре
                    const gameAvatar = document.querySelector('.p-play__profile-img');
                    if (gameAvatar) {
                        gameAvatar.src = data.savedAvatarUrl;
                    }

                    // Обновляем аватар в профиле
                    const profileAvatar = document.querySelector('.avatarlvl__avatar');
                    if (profileAvatar) {
                        // Удаляем iframe с 3D моделью
                        profileAvatar.innerHTML = '';
                        
                        // Создаем контейнер для изображения
                        const container = document.createElement('div');
                        container.style.cssText = `
                            width: 100%;
                            height: 100%;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            overflow: hidden;
                        `;

                        // Создаем и добавляем изображение
                        const img = document.createElement('img');
                        img.src = data.savedAvatarUrl;
                        img.style.cssText = `
                            width: auto;
                            height: 100%;
                            max-width: none;
                        `;

                        container.appendChild(img);
                        profileAvatar.appendChild(container);

                        // Удаляем ненужные иконки
                        const icons = document.querySelector('.avatarlvl__icons');
                        if (icons) {
                            icons.remove();
                        }
                    }
                }
            } catch (error) {
                console.error('Error loading saved avatar:', error);
            }
        }

        setupAvatarObserver() {
            // Наблюдаем за изменениями DOM для обработки динамически добавляемых элементов
            const observer = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === 1) { // Элемент
                            // Проверяем наличие 3D аватара в профиле
                            const profileAvatar = node.querySelector('.avatarlvl__avatar');
                            if (profileAvatar) {
                                this.loadSavedAvatar();
                            }
                        }
                    }
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        }

        checkGameState() {
            const gameElement = document.querySelector('.game');
            const lobbyElement = document.querySelector('.lobby');
            
            if (gameElement || lobbyElement) {
                console.log('Game or lobby detected, activating script...');
                this.activateScript();
            }
        }

        setupMatchPageHandler() {
            if (window.location.pathname.includes('/match/')) {
                this.activateScript();
            }
        }

        processElement(element) {
            if (this.settings.statistics_enabled === false) {
                this.removeStatisticsElements();
                return;
            }

            if (!element || !element.classList.contains('player')) return;

            const nicknameElement = element.querySelector('.player__info .info__name');
            if (!nicknameElement) return;

            const username = nicknameElement.textContent.trim();
            if (!username) return;

            // Проверяем и добавляем кнопки статистики и заметок
            this.injectPlayerButtons(element, username);
        }

        injectPlayerButtons(container, username) {
            if (this.settings.statistics_enabled === false) {
                this.removeStatisticsElements();
                return;
            }

            const videoWrapper = container.querySelector('.player__video-wrapper');
            const infoContainer = container.querySelector('.player__info');

            if (!videoWrapper || !infoContainer) return;

            // Удаляем старые кнопки перед добавлением новых (глобально на всякий случай)
            this.removeOldButtons(username);

            // Дополнительно: чистим все существующие контейнеры .player-icons внутри этого игрока,
            // чтобы исключить дублирование при смене слота/фазы
            const existingGroups = infoContainer.querySelectorAll('.player-icons');
            if (existingGroups.length) {
                existingGroups.forEach(g => g.remove());
            }

            // Создаем/находим общий контейнер для иконок
            let iconsGroup = infoContainer.querySelector('.player-icons');
            if (!iconsGroup) {
                iconsGroup = document.createElement('div');
                iconsGroup.className = 'player-icons';
                infoContainer.appendChild(iconsGroup);
            }

            // Добавляем кнопку статистики
            if (!iconsGroup.querySelector(`.stats-button[data-username="${username}"]`)) {
                const statsButton = this.createStatsButton(username);
                if (statsButton) iconsGroup.appendChild(statsButton);
            }

            // Добавляем кнопку заметки
            if (!iconsGroup.querySelector(`.note-button[data-username="${username}"]`)) {
                const noteButton = this.createNoteButton(username);
                iconsGroup.appendChild(noteButton);
            }

            if (!iconsGroup.querySelector(`.last-games-button[data-username="${username}"]`)) {
                const lastGamesButton = this.createLastGamesButton(username);
                iconsGroup.appendChild(lastGamesButton);
            }

            // Добавляем кнопку скрытия видео
            if (!iconsGroup.querySelector(`.hide-video-button[data-username="${username}"]`)) {
                const hideBtn = this.createHideVideoButton(username, container);
                iconsGroup.appendChild(hideBtn);
            }

            // Применяем состояние скрытия, если оно активно для этого пользователя
            if (this.hiddenVideos.has(username.toLowerCase())) {
                const vid = container.querySelector('.player__video, .player__video-wrapper');
                if (vid) vid.style.display = 'none';
            }
        }

        removeOldButtons(username) {
            // Удаляем старые кнопки, чтобы избежать дубликатов при реинициализации
            const selectors = [
                `.note-button[data-username="${username}"]`,
                `.stats-button[data-username="${username}"]`,
                `.last-games-button[data-username="${username}"]`,
                `.hide-video-button[data-username="${username}"]`
            ];
            selectors.forEach(sel => {
                document.querySelectorAll(sel).forEach(btn => btn.remove());
            });
        }

        createHideVideoButton(username, playerContainer) {
            const button = document.createElement('button');
            button.className = 'hide-video-button';
            button.dataset.username = username;
            button.title = `Скрыть/показать камеру ${username}`;
            button.style.cssText = `
                background: none;
                border: none;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 1000;
                transition: all 0.2s ease;
                opacity: 1 !important;
                visibility: visible !important;
            `;

            // Иконка крестика
            button.innerHTML = `
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="color: rgba(66, 103, 178, 0.9);">
                    <path d="M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    <path d="M6 6L18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
            `;

            button.addEventListener('click', () => {
                const uname = username.toLowerCase();
                const videoEl = playerContainer.querySelector('.player__video, .player__video-wrapper');
                if (!videoEl) return;
                const isHidden = this.hiddenVideos.has(uname);
                if (isHidden) {
                    videoEl.style.display = '';
                    this.hiddenVideos.delete(uname);
                } else {
                    videoEl.style.display = 'none';
                    this.hiddenVideos.add(uname);
                }
            });

            this.applyButtonTheme(button);
            return button;
        }

        setupSlotChangeObserver() {
            const observer = new MutationObserver((mutations) => {
                mutations.forEach(mutation => {
                    if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                        const playerElement = mutation.target;
                        if (playerElement.classList.contains('player')) {
                            const nicknameElement = playerElement.querySelector('.player__info .info__name');
                            if (nicknameElement) {
                                const username = nicknameElement.textContent.trim();
                                this.injectPlayerButtons(playerElement, username);
                            }
                        }
                    }
                });
            });

            const players = document.querySelectorAll('.player');
            players.forEach(player => {
                observer.observe(player, {
                    attributes: true,
                    attributeFilter: ['class']
                });
            });
        }

        createLastGamesButton(username) {
            const button = document.createElement('button');
            button.className = 'last-games-button';
            button.dataset.username = username;
            // Позиционирование и размеры контролируются через notes.css
            button.style.cssText = `
                background: none;
                border: none;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 1000;
                transition: all 0.2s ease;
                opacity: 1 !important;
                visibility: visible !important;
            `;

            button.innerHTML = `
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="color: rgba(66, 103, 178, 0.9);">
                    <path d="M12 8V12L15 15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/>
                </svg>
            `;

            // Создаем тултип как в createTooltip
            const tooltip = document.createElement('div');
            tooltip.className = 'tooltip';
            tooltip.style.cssText = `
                position: absolute;
                bottom: 100%;
                left: 0;
                transform: translateY(10px);
                background: rgba(11, 27, 57, 0.9);
                backdrop-filter: blur(8px);
                border: 1px solid rgba(79, 129, 245, 0.3);
                padding: 10px;
                border-radius: 8px;
                font-size: 12px;
                visibility: hidden;
                opacity: 0;
                transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                pointer-events: none;
                white-space: normal;
                min-width: 120px;
                z-index: 1001;
                line-height: 1.3;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
                margin-bottom: 5px;
                color: white;
            `;

            button.addEventListener('mouseenter', async () => {
                tooltip.innerHTML = 'Загрузка...';
                tooltip.style.visibility = 'visible';
                tooltip.style.opacity = '1';
                
                const games = await this.getLastGames(username);
                if (games.length > 0) {
                    tooltip.innerHTML = this.formatGamesHistory(games);
                } else {
                    tooltip.innerHTML = 'Нет данных о последних играх';
                }
            });

            button.addEventListener('mouseleave', () => {
                tooltip.style.visibility = 'hidden';
                tooltip.style.opacity = '0';
            });

            button.appendChild(tooltip);
            this.applyButtonTheme(button);
            return button;
        }

        async showLastGamesModal(username) {
            const modal = document.createElement('div');
            modal.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: rgba(11, 27, 57, 0.95);
                padding: 20px;
                border-radius: 8px;
                z-index: 10000;
                min-width: 300px;
                border: 1px solid rgba(79, 129, 245, 0.3);
                box-shadow: 0 0 20px rgba(0, 0, 0, 0.5);
            `;

            const title = document.createElement('h3');
            title.textContent = `Последние игры ${username}`;
            title.style.cssText = `
                margin: 0 0 15px 0;
                color: white;
                font-size: 16px;
            `;

            const content = document.createElement('div');
            content.innerHTML = 'Загрузка...';
            content.style.color = 'white';

            // Получаем последние игры
            try {
                const games = await this.getLastGames(username);
                content.innerHTML = this.formatGamesHistory(games);
            } catch (error) {
                content.innerHTML = 'Ошибка загрузки истории игр';
                console.error('Error loading games history:', error);
            }

            const closeButton = document.createElement('button');
            closeButton.textContent = 'Закрыть';
            closeButton.style.cssText = `
                padding: 8px 16px;
                background: rgba(255, 255, 255, 0.1);
                color: white;
                border: none;
                border-radius: 8px;
                cursor: pointer;
                margin-top: 15px;
            `;

            closeButton.addEventListener('click', () => {
                document.body.removeChild(modal);
            });

            modal.appendChild(title);
            modal.appendChild(content);
            modal.appendChild(closeButton);
            document.body.appendChild(modal);
        }

        async getLastGames(username) {
            try {
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Timeout')), 15000)
                );

                const dataPromise = new Promise(async (resolve) => {
                    try {
                        const playerStats = this.playerStats.get(username.toLowerCase());
                        let userId;
                        
                        if (playerStats && playerStats.id) {
                            userId = playerStats.id;
                        } else {
                            try {
                                const response = await fetch('https://polemicagame.com/rating/get-list?limit=1000');
                                if (!response.ok) {
                                    console.warn(`API вернул ошибку: ${response.status}`);
                                    resolve([]);
                                    return;
                                }
                                
                                const players = await response.json();
                                const player = players.find(p => p.username.toLowerCase() === username.toLowerCase());
                                if (!player) {
                                    console.warn(`Игрок ${username} не найден в рейтинге`);
                                    resolve([]);
                                    return;
                                }
                                userId = player.user_id;
                            } catch (error) {
                                console.warn('Ошибка при поиске ID игрока:', error);
                                resolve([]);
                                return;
                            }
                        }

                        try {
                            const gamesResponse = await fetch(`https://polemicagame.com/profile/default/get-games?userId=${userId}&page=1&limit=4`);
                            if (!gamesResponse.ok) {
                                console.warn(`API игр вернул ошибку: ${gamesResponse.status}`);
                                resolve([]);
                                return;
                            }
                            
                            const data = await gamesResponse.json();
                            
                            if (data && data.rows) {
                                const processedGames = data.rows.map(game => ({
                                    role: game.role?.type === 'don' ? 'godfather' : game.role?.type || 'civilian',
                                    isWin: game.result?.code === 'success',
                                    mmrChange: parseInt(game.mmr?.mmr_diff) || 0
                                }));
                                resolve(processedGames);
                            } else {
                                console.warn('API игр вернул пустые данные');
                                resolve([]);
                            }
                        } catch (error) {
                            console.warn('Ошибка при получении истории игр:', error);
                            resolve([]);
                        }
                    } catch (error) {
                        console.warn('Общая ошибка в dataPromise:', error);
                        resolve([]);
                    }
                });

                return await Promise.race([dataPromise, timeoutPromise]);
            } catch (error) {
                console.error('Error fetching last games:', error);
                return [];
            }
        }

        formatGamesHistory(games) {
            if (!games || games.length === 0) return 'Нет данных о последних играх';

            return games.map(game => `
                <div style="display: flex; align-items: center; gap: 5px; margin-bottom: 5px;">
                    ${this.createRoleSvg(game.role, 14)}
                    <span style="color: ${game.isWin ? '#4CAF50' : '#f44336'}">${game.isWin ? 'Победа' : 'Поражение'}</span>
                    <span style="color: ${game.mmrChange >= 0 ? '#4CAF50' : '#f44336'}">${game.mmrChange >= 0 ? '+' : ''}${game.mmrChange}</span>
                </div>
            `).join('');
        }

        resolveRoleSpriteBaseUrl() {
            if (this.roleSpriteBaseUrl) return this.roleSpriteBaseUrl;

            const roleMarkers = ['#civilian', '#sheriff', '#mafia', '#godfather'];

            const hasInlineSprite = document.querySelector('symbol#civilian, symbol#sheriff, symbol#mafia, symbol#godfather');
            if (hasInlineSprite) {
                this.roleSpriteBaseUrl = '';
                return this.roleSpriteBaseUrl;
            }

            const useElements = document.querySelectorAll('use[href], use[xlink\\:href]');

            for (const useEl of useElements) {
                const rawHref = useEl.getAttribute('href') || useEl.getAttribute('xlink:href');
                if (!rawHref) continue;

                if (roleMarkers.includes(rawHref)) {
                    this.roleSpriteBaseUrl = '';
                    return this.roleSpriteBaseUrl;
                }

                if (!rawHref.includes('/bundle/') || !rawHref.includes('.svg')) continue;
                if (!roleMarkers.some(marker => rawHref.includes(marker))) continue;

                const base = rawHref.split('#')[0];
                if (base) {
                    this.roleSpriteBaseUrl = base;
                    return base;
                }
            }

            for (const useEl of useElements) {
                const rawHref = useEl.getAttribute('href') || useEl.getAttribute('xlink:href');
                if (!rawHref) continue;
                if (!rawHref.includes('/bundle/') || !rawHref.includes('.svg')) continue;

                const base = rawHref.split('#')[0];
                if (base) {
                    this.roleSpriteBaseUrl = base;
                    return base;
                }
            }

            const defaultPrefix = window.location.pathname.includes('/new-room/') ? '/new-room/bundle/' : '/room/bundle/';
            this.roleSpriteBaseUrl = `${defaultPrefix}f59bacbc2885635c4d91.svg`;
            return this.roleSpriteBaseUrl;
        }

        createRoleSvg(roleId, size) {
            const base = this.resolveRoleSpriteBaseUrl();
            const href = `${base}#${roleId}`;
            return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size}" height="${size}"><use href="${href}" xlink:href="${href}"></use></svg>`;
        }

        getRoleIcon(role) {
            const roleIcons = {
                citizen: '👨',
                mafia: '🔫',
                don: '👑',
                sheriff: '🚔',
                doctor: '💉'
                // Добавьте другие роли по необходимости
            };
            return roleIcons[role.toLowerCase()] || role;
        }

        autoHideRoles() {
            return;
            if (this.settings.auto_hide_roles_enabled === false) {
                return;
            }

            // Создаем событие нажатия клавиши D
            const keyEvent = new KeyboardEvent('keydown', {
                key: 'd',
                code: 'KeyD',
                keyCode: 68,
                which: 68,
                bubbles: true,
                cancelable: true
            });

            // Имитируем нажатие сразу после загрузки DOM
            setTimeout(() => {
                document.dispatchEvent(keyEvent);
            }, 100); // Задержка 100мс для гарантированной загрузки
        }
    }

    // Создаем экземпляр менеджера
    const notesManager = new NotesManager();

    // Добавляем обработчик сообщений от страницы
    window.addEventListener('message', async function(event) {
        if (event.source !== window) return;

        if (event.data.type === 'GET_STORAGE') {
            const data = await new Promise(resolve => {
                chrome.storage.sync.get(event.data.keys, resolve);
            });
            window.postMessage({
                type: 'STORAGE_RESPONSE',
                requestId: event.data.requestId,
                data: data
            }, '*');
        }

        if (event.data.type === 'SET_STORAGE') {
            chrome.storage.sync.set(event.data.data);
        }
    });

    // Обновление при возвращении на вкладку
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            notesManager.updateAllPlayers();
        }
    });

    // Обработчик изменения состояния игры
    document.addEventListener('gameStateChanged', () => {
        notesManager.updateAllPlayers();
    });

    // Обработчик смены дня/ночи
    document.addEventListener('dayNightChanged', () => {
        notesManager.updateAllPlayers();
    });

    // Добавляем обработчик для сохранения состояния при закрытии страницы
    window.addEventListener('beforeunload', () => {
        chrome.storage.local.set({ 
            scriptActivated: true,
            lastActivation: Date.now()
        });
    });

    // Дополнительная проверка при загрузке страницы
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => {
            const playersExist = document.querySelectorAll('.player').length > 0;
            const statsExist = document.querySelectorAll('.player-stats').length > 0;
            
            if (playersExist && !statsExist) {
                console.log('Initial check: Statistics missing, activating...');
                window.notesManager.activateScript();
            }
        }, 3000);
    });
})();
