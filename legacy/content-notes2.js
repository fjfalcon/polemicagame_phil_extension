(function() {
    console.log("PLAYER NOTES SCRIPT LOADED!");

    class NotesManager {
        constructor() {
            console.log('Initializing NotesManager');
            this.VERSION = '1.0';
            this.notes = {};
            this.playerStats = new Map();
            this.settings = {
                show_mmr: true,
                show_games: true,
                show_id: false,
                show_winrate: true,
                show_kills: true,
                show_roles: true
            };

            chrome.storage.sync.get({
                notes: {},
                version: this.VERSION,
                show_mmr: true,
                show_games: true,
                show_id: false,
                show_winrate: true,
                show_kills: true,
                show_roles: true
            }, (result) => {
                this.notes = result.notes;
                this.settings.show_mmr = result.show_mmr;
                this.settings.show_games = result.show_games;
                this.settings.show_id = result.show_id;
                this.settings.show_winrate = result.show_winrate;
                this.settings.show_kills = result.show_kills;
                this.settings.show_roles = result.show_roles;
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

            this.setupDayNightObserver();

            // Добавляем периодическую проверку статистики
            this.setupStatisticsChecker();

            this.addMatchPageStyles();

            this.loadSavedAvatar();
            this.setupAvatarObserver();

            chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
                if (message.type === 'updateAvatar') {
                    const avatarImg = document.querySelector('.p-play__profile-img');
                    if (avatarImg) {
                        avatarImg.src = message.imageUrl;
                    }
                }
            });
        }

        async init() {
            await this.loadSettings();
            this.injectNotesManually();
            this.setupMutationObserver();
            this.setupStateChangeHandler();

            // Слушаем изменения настроек
            chrome.storage.sync.onChanged.addListener((changes) => {
                for (let key in changes) {
                    if (key in this.settings) {
                        this.settings[key] = changes[key].newValue;
                        this.updateAllTooltips();
                    }
                }
            });
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
            try {
                const response = await fetch('https://polemicagame.com/rating/get-list?limit=20000');
                const players = await response.json();
                const player = players.find(p => p.username.toLowerCase() === username.toLowerCase());

                if (!player) {
                    console.log(`Player ${username} not found in rating list`);
                    return;
                }

                const userId = player.user_id;
                
                // Используем правильные URL для API
                let [generalStats, roleStats, killcount] = await Promise.all([
                    fetch(`https://polemicagame.com/profile/get-role-statistic?user_id=${userId}&role=&game_type=league&scoring_type=scoring_2`).then(r => r.json()),
                    fetch(`https://polemicagame.com/profile/get-statistic?user_id=${userId}&game_type=league&scoring_type=scoring_2`).then(r => r.json()),
                    fetch(`https://polemicagame.com/profile/get-role-statistic?user_id=${userId}&role=civilian%2Csheriff&game_type=league&scoring_type=scoring_2`).then(r => r.json()),


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
                    totalGames: player.total_games || '?',
                    id: player.user_id,
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
            const statsButton = document.createElement('div');
            statsButton.className = 'stats-button';
            statsButton.dataset.username = username;
            statsButton.style.cssText = `
                position: absolute;
                left: 4px;
                bottom: 38px;
                width: 32px;
                height: 32px;
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
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="rgb(66, 103, 178)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
                svg.style.stroke = 'rgb(74, 118, 238)';
                tooltip.style.visibility = 'visible';
                tooltip.style.opacity = '1';
                tooltip.style.transform = 'translateY(0)';
            });

            statsButton.addEventListener('mouseleave', () => {
                const svg = statsButton.querySelector('svg');
                svg.style.stroke = 'rgb(66, 103, 178)';
                tooltip.style.visibility = 'hidden';
                tooltip.style.opacity = '0';
                tooltip.style.transform = 'translateY(10px)';
            });

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

                    const existingButton = videoWrapper.querySelector(`.stats-button[data-username="${username}"]`);
                    const existingNoteButton = infoContainer.querySelector(`.note-button[data-username="${username}"]`);
                    const existingButtonContainer = infoContainer.querySelector(`.button-container[data-username="${username}"]`);

                    if (!existingButton || !existingNoteButton) {
                        // Используем сохраненную статистику
                        if (this.playerStats.has(username.toLowerCase())) {
                            this.playerStats.set(username.toLowerCase(), currentStats);
                        }

                        // Добавляем кнопки только если их нет
                        if (!existingButton) {
                            const statsButton = this.createStatsButton(username);
                            // Делаем кнопку видимой даже при скрытой веб-камере
                            statsButton.style.opacity = '1';
                            statsButton.style.visibility = 'visible';
                            videoWrapper.appendChild(statsButton);
                        }

                        if (!existingNoteButton && !existingButtonContainer) {
                            const noteButton = this.createNoteButton(username);
                            const buttonContainer = document.createElement('div');
                            buttonContainer.className = 'button-container';
                            buttonContainer.dataset.username = username;
                            buttonContainer.style.cssText = `
                                display: flex;
                                gap: 4px;
                                margin-left: 5px;
                                opacity: 1 !important;
                                visibility: visible !important;
                            `;
                            buttonContainer.appendChild(noteButton);
                            infoContainer.appendChild(buttonContainer);
                        }
                    }

                    // Убеждаемся, что кнопки всегда видны
                    if (existingButton) {
                        existingButton.style.opacity = '1';
                        existingButton.style.visibility = 'visible';
                    }
                    if (existingButtonContainer) {
                        existingButtonContainer.style.opacity = '1';
                        existingButtonContainer.style.visibility = 'visible';
                    }
                }
            });
        }

        createNoteButton(username) {
            const button = document.createElement('button');
            button.className = 'note-button';
            button.dataset.username = username;
            button.style.cssText = `
                background: transparent;
                border: none;
                cursor: pointer;
                padding: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                width: 22px;
                height: 22px;
                margin-left: 5px;
                transition: all 0.2s ease;
            `;

            // Возвращаем оригинальную SVG иконку заметок
            button.innerHTML = `
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M19 3H5C3.89543 3 3 3.89543 3 5V19C3 20.1046 3.89543 21 5 21H19C20.1046 21 21 20.1046 21 19V5C21 3.89543 20.1046 3 19 3Z" 
                        stroke="url(#note-gradient)" 
                        stroke-width="2" 
                        stroke-linecap="round" 
                        stroke-linejoin="round"/>
                    <path d="M8 12L16 12M8 8L16 8M8 16L13 16" 
                        stroke="url(#note-gradient)" 
                        stroke-width="2" 
                        stroke-linecap="round" 
                        stroke-linejoin="round"/>
                    <defs>
                        <linearGradient id="note-gradient" x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
                            <stop stop-color="#6366F1"/>
                            <stop offset="1" stop-color="#8B5CF6"/>
                        </linearGradient>
                    </defs>
                </svg>
            `;

            // Добавляем эффекты при наведении
            button.addEventListener('mouseenter', () => {
                const svg = button.querySelector('svg');
                svg.style.transform = 'scale(1.1)';
            });

            button.addEventListener('mouseleave', () => {
                const svg = button.querySelector('svg');
                svg.style.transform = 'scale(1)';
            });

            button.title = `Заметка для игрока ${username}`;
            button.addEventListener('click', () => this.showNoteModal(username));
            
            return button;
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
                height: 24px;
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
                background: rgba(28, 28, 35, 0.95);
                padding: 20px;
                border-radius: 8px;
                z-index: 10000;
                min-width: 300px;
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

            const closeButton = document.createElement('button');
            closeButton.textContent = 'Закрыть';
            closeButton.style.cssText = `
                padding: 8px 16px;
                background: rgba(255, 255, 255, 0.1);
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

            closeButton.addEventListener('click', () => {
                document.body.removeChild(modal);
            });

            modal.appendChild(title);
            modal.appendChild(textarea);
            modal.appendChild(saveButton);
            modal.appendChild(closeButton);

            document.body.appendChild(modal);
        }

        async loadSettings() {
            const result = await chrome.storage.sync.get({
                show_mmr: true,
                show_games: true,
                show_id: false,
                show_winrate: true,
                show_kills: true,
                show_roles: true
            });
            this.settings = result;
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
            
            let tooltipContent = `<div style="margin-bottom: 6px; font-size: 11px; color: rgba(255, 255, 255, 0.9);">${noteText}</div>`;
            tooltipContent += `<div style="color: rgba(255, 255, 255, 0.7); font-size: 10px;">`;
            
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
                    `<div style="margin-top: 4px; font-size: 10px; color: rgba(255, 255, 255, 0.8); display: grid; grid-template-columns: 1fr 1fr; gap: 4px;">` +
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
                background: rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(8px);
                border: 1px solid rgba(255, 255, 255, 0.2);
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
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
                margin-bottom: 5px;
                color: white;
            `;

            tooltip.innerHTML = this.generateTooltipContent(username);
            return tooltip;
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

        setupMutationObserver() {
            const observer = new MutationObserver((mutations) => {
                // Проверяем, находимся ли мы на странице матча
                if (window.location.pathname.includes('/match/')) {
                mutations.forEach(mutation => {
                        if (mutation.addedNodes.length) {
                        mutation.addedNodes.forEach(node => {
                                if (node.nodeType === 1) { // Проверяем, что это элемент
                                    const stopIcons = node.querySelectorAll('[xlink\\:href$="#stop"]');
                                    stopIcons.forEach(icon => {
                                        const iconParent = icon.closest('svg');
                                        if (iconParent) {
                                            iconParent.style.display = 'none';
                                        }
                                    });
                            }
                        });
                    }
                });
                    return; // Выходим из обработчика для страницы матча
                }

                // Остальной код для других страниц
                mutations.forEach(mutation => {
                    mutation.addedNodes.forEach(node => {
                        if (node.classList && node.classList.contains('player')) {
                            this.processElement(node);
                        }
                    });
                });
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
                const players = document.querySelectorAll('.player');
                players.forEach(player => {
                    if (!player.querySelector('.player-stats')) {
                        this.updatePlayer(player);
                    }
                });
            }, 1000);
        }

        async updatePlayer(playerElement) {
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
            try {
                this.processExistingElements();
                this.setupMutationObserver();
            } catch (error) {
                console.error('Error activating script:', error);
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

        setupStatisticsChecker() {
            // Проверяем каждые 5 секунд
                setInterval(() => {
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

            // Добавляем слушатель изменений DOM для отслеживания смены дня/ночи
            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (mutation.type === 'attributes' && 
                        mutation.attributeName === 'class' && 
                        mutation.target === document.body) {
                        
                        const isDayChange = mutation.target.classList.contains('day') || 
                                          mutation.target.classList.contains('night');
                        
                        if (isDayChange) {
                            console.log('Day/Night changed, scheduling reactivation...');
                            // Даем время на обновление DOM
                            setTimeout(() => {
                                const playersExist = document.querySelectorAll('.player').length > 0;
                                const statsExist = document.querySelectorAll('.player-stats').length > 0;
                                
                                if (playersExist && !statsExist) {
                                    console.log('Reactivating statistics after day/night change...');
                                    this.activateScript();
                                    this.updateAllPlayers();
                                }
                            }, 1000);
                        }
                    }
                });
            });

            observer.observe(document.body, {
                attributes: true,
                attributeFilter: ['class']
            });
        }

        processExistingElements() {
            // Проверяем, находимся ли мы на странице матча
            if (window.location.pathname.includes('/match/')) {
                // Удаляем красные стопы со страницы матча
                const stopIcons = document.querySelectorAll('[xlink\\:href$="#stop"]');
                stopIcons.forEach(icon => {
                    const iconParent = icon.closest('svg');
                    if (iconParent) {
                        iconParent.style.display = 'none';
                    }
                });
                return; // Выходим из функции, так как это страница матча
            }

            // Остальной код для обработки элементов на других страницах
            const elements = document.querySelectorAll('.player');
            elements.forEach(element => this.processElement(element));
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
        }, 2000);
    });
})();
