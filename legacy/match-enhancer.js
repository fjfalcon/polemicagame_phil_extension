class MatchEnhancer {
    constructor() {
        console.log('MatchEnhancer initialized');
        this.settings = {
            statistics_enabled: true,
            match_page_stats_enabled: true
        };
        try {
            chrome.storage.sync.get({
                statistics_enabled: true,
                match_page_stats_enabled: true
            }, (settings) => {
                this.settings = {
                    statistics_enabled: settings.statistics_enabled !== false,
                    match_page_stats_enabled: settings.match_page_stats_enabled !== false
                };
            });
            chrome.runtime.onMessage.addListener((message) => {
                if (message.type === 'updateNotesSettings' && message.settings) {
                    this.settings = { ...this.settings, ...message.settings };
                    if (this.settings.statistics_enabled === false || this.settings.match_page_stats_enabled === false) {
                        this.removeEnhancements();
                    }
                }
            });
        } catch (_) {}

        // Listen for game data
        document.addEventListener('gameDataParsed', (event) => {
            if (this.settings.statistics_enabled === false || this.settings.match_page_stats_enabled === false) {
                return;
            }
            console.log('Received game data, enhancing page...');
            this.enhance(event.detail);
        });
    }

    // В начале метода enhance добавим:
    // В методе enhance изменим HTML структуру заголовка
    enhance(gameData) {
        const header = document.querySelector('.game-stats-header');
        if (header) {
            const gameId = gameData.id || '';
            const isMafiaWin = gameData.winnerCode !== 0;
            
            // Определяем цвет и текст в зависимости от победителя
            const winnerColor = isMafiaWin ? '#ef4444' : '#22c55e'; // красный для мафии, зеленый для мирных
            const winnerText = isMafiaWin ? 'Победа мафии' : 'Победа мирных';
            
            header.style.cssText = `
                background: rgba(30, 41, 59, 0.5);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 12px;
                padding: 16px 24px;
                margin-bottom: 16px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
            `;
            
            header.innerHTML = `
                <span class="header-info" style="font-size: 24px; color: #0ea5e9;">Статистика игры (ID${gameId})</span>
                <span class="header-info text-right" style="font-size: 24px; color: ${winnerColor}; font-weight: 500;">${winnerText}</span>
            `;
            
            header.setAttribute('data-v-33ae8458', '');
        }

        console.log('Starting page enhancement');
        // Wait for table to be available
        const checkTable = setInterval(() => {
            console.log('Looking for table...');
            const table = document.querySelector('.game-stats-table .table');
            
            if (table) {
                console.log('Table found, enhancing...');
                clearInterval(checkTable);
                this.enhanceTable(table, gameData);
                // Добавляем небольшую задержку для гарантированного добавления точек
                setTimeout(() => {
                    this.addPenaltyIndicators(table, gameData);
                }, 100);
            } else {
                console.log('Table not found, retrying...');
            }
        }, 500);

        // Stop checking after 10 seconds
        setTimeout(() => clearInterval(checkTable), 10000);
    }

    removeEnhancements() {
        document.querySelectorAll('.row[data-phase], .best-move-dot, .best-move-tooltip').forEach((element) => {
            element.remove();
        });
    }

    enhanceTable(table, gameData) {
        const gameDetails = gameData.data || {};
        const players = gameDetails.players || [];
        const phases = this.processGamePhases(gameDetails);
        
        // Находим строку с ролями
        const rows = Array.from(table.querySelectorAll('.row'));
        const roleRow = rows.find(row => 
            row.querySelector('.cell.title')?.textContent.trim() === 'Роль'
        );

        if (!roleRow) {
            console.log('Role row not found');
            return;
        }

        let lastInsertedRow = roleRow;
        phases.forEach((phase, index) => {
            const phaseNumber = index + 1;
            
            // Всегда создаем строку для дня
            const dayRow = document.createElement('div');
            dayRow.className = 'row';
            dayRow.setAttribute('data-v-1db9d42a', '');
            dayRow.setAttribute('data-phase', `day-${phaseNumber}`);
            
            const dayTitleCell = document.createElement('div');
            dayTitleCell.className = 'cell title role';
            dayTitleCell.innerHTML = `<span class="phase-title">${phaseNumber} ☀️</span>`;
            dayRow.appendChild(dayTitleCell);
            
            // Добавляем ячейки для каждого игрока
            players.forEach(player => {
                const cell = document.createElement('div');
                cell.className = 'cell player role';
                cell.setAttribute('data-player', player.position);
                
                // Получаем все голоса для игрока
                const votes = phase.day.filter(a => a.to === player.position);
                
                // Разделяем на два голосования
                const firstVotes = votes.filter(v => !v.num || v.num === 1);
                const secondVotes = votes.filter(v => v.num === 2);

                let html = '';

                // Показываем первое голосование
                if (firstVotes.length > 0) {
                    html += `<div class="action">
                        ${firstVotes.map(v => {
                            const voter = players.find(p => p.position === v.from);
                            let voterClass = 'voter';
                            if (voter.role === 0) voterClass += ' don-vote';
                            if (voter.role === 1) voterClass += ' mafia-vote';
                            if (voter.role === 3) voterClass += ' sheriff-vote';
                            
                            // Добавляем встроенные стили для цветов
                            let voterStyle = '';
                            if (voter.role === 0) voterStyle = 'color: #9333ea;'; // дон
                            else if (voter.role === 1) voterStyle = 'color: white;'; // мафия
                            else if (voter.role === 3) voterStyle = 'color: #eab308;'; // шериф
                            else voterStyle = 'color: #ef4444;'; // обычный игрок
                            
                            return `<span class="${voterClass}" style="${voterStyle}">${v.from}</span>`;
                        }).join('')}
                    </div>`;
                }

                // Показываем второе голосование в новой строке
                if (secondVotes.length > 0) {
                    html += `<div class="action" style="margin-top: 4px;">
                        ${secondVotes.map(v => {
                            const voter = players.find(p => p.position === v.from);
                            let voterClass = 'voter';
                            if (voter.role === 0) voterClass += ' don-vote';
                            if (voter.role === 1) voterClass += ' mafia-vote';
                            if (voter.role === 3) voterClass += ' sheriff-vote';
                            
                            // Добавляем встроенные стили для цветов
                            let voterStyle = '';
                            if (voter.role === 0) voterStyle = 'color: #9333ea;'; // дон
                            else if (voter.role === 1) voterStyle = 'color: white;'; // мафия
                            else if (voter.role === 3) voterStyle = 'color: #eab308;'; // шериф
                            else voterStyle = 'color: #ef4444;'; // обычный игрок
                            
                            return `<span class="${voterClass}" style="${voterStyle}">${v.from}</span>`;
                        }).join('')}
                    </div>`;
                }

                cell.style.cssText = `
                    display: flex;
                    flex-direction: row;
                    flex-wrap: wrap;
                    align-items: center;
                    justify-content: center;
                    gap: 4px;
                `;
                cell.innerHTML = html;
                dayRow.appendChild(cell);
            });
            
            lastInsertedRow.insertAdjacentElement('afterend', dayRow);
            lastInsertedRow = dayRow;

            // Добавляем ночную фазу, если есть действия
            if (phase.night.length > 0) {
                const nightRow = this.createNightRow(phaseNumber, phase, players);
                lastInsertedRow.insertAdjacentElement('afterend', nightRow);
                lastInsertedRow = nightRow;
            }
        });

        setTimeout(() => {
            this.addBestMoveIndicators(table, gameData);
            console.log('Best move indicators added');
        }, 100);
    }

    createNightRow(phaseNumber, phase, players) {
        const nightRow = document.createElement('div');
        nightRow.className = 'row';
        nightRow.setAttribute('data-v-1db9d42a', '');
        nightRow.setAttribute('data-phase', `night-${phaseNumber}`);
        
        const nightTitleCell = document.createElement('div');
        nightTitleCell.className = 'cell title';
        nightTitleCell.innerHTML = `<span class="phase-title">${phaseNumber} 🌙</span>`;
        nightRow.appendChild(nightTitleCell);
        
        players.forEach(player => {
            const cell = document.createElement('div');
            cell.className = 'cell player';
            cell.setAttribute('data-player', player.position);
            
            const actions = phase.night.filter(a => a.from === player.position);
            cell.innerHTML = actions.map(action => {
                const icon = this.getActionIcon(action.type);
                return `<div class="action ${action.type}">
                    ${icon} ${action.to}
                </div>`;
            }).join('');
            
            nightRow.appendChild(cell);
        });
        
        return nightRow;
    }

    addBestMoveIndicators(table, gameData) {
        console.log('Adding best move indicators...');
        console.log('Game data:', gameData);
        const players = gameData.data?.players || [];
        
        players.forEach(player => {
            console.log('Processing player:', player);
            // Проверяем наличие любых догадок
            if (player.guess?.completed || player.guess?.mafs || player.guess?.civs || player.guess?.vice !== undefined) {
                console.log(`Found guess data for player ${player.position}:`, player.guess);
                
                const playerPosition = player.position;
                // Проверяем, есть ли хоть какие-то догадки
                const hasGuesses = (
                    (player.guess.mafs && player.guess.mafs.length > 0) ||
                    (player.guess.civs && player.guess.civs.length > 0) ||
                    player.guess.vice !== undefined
                );

                if (hasGuesses) {
                    // Сначала проверяем ночные убийства
                    const shotNight = this.findShotNight(playerPosition, gameData);
                    console.log('Shot night:', shotNight);
                    // Только если не нашли ночь убийства, проверяем голосования
                    const votedDay = shotNight === null ? this.findVotedDay(playerPosition, gameData) : null;
                    console.log('Voted day:', votedDay);
                    
                    // Определяем, где ставить точку - либо в день голосования, либо в ночь убийства
                    if (shotNight !== null) {
                        console.log(`Adding night dot for player ${playerPosition} at night ${shotNight}`);
                        this.addDotToCell(table, playerPosition, 'night', shotNight, player.guess);
                    } else if (votedDay !== null) {
                        console.log(`Adding day dot for player ${playerPosition} at day ${votedDay}`);
                        this.addDotToCell(table, playerPosition, 'day', votedDay, player.guess);
                    }
                }
            }
        });
        
        this.addBestMoveStyles();
    }

    // Метод для добавления точки в конкретную ячейку
    addDotToCell(table, playerPosition, phaseType, phaseNumber, guessData) {
        const rows = table.querySelectorAll('.row');
        rows.forEach(row => {
            const phaseCell = row.querySelector('.cell.title');
            const phaseText = phaseCell?.textContent || '';
            console.log('Checking row with phase:', phaseText);

            const isTargetRow = phaseType === 'night'
                ? phaseText.includes(`${phaseNumber} 🌙`)
                : phaseText.includes(`${phaseNumber} ☀️`);

            if (isTargetRow) {
                console.log(`Found matching ${phaseType} row`);
                const playerCell = row.querySelector(`.cell[data-player="${playerPosition}"]`);
                console.log('Found player cell:', playerCell);

                if (playerCell && !playerCell.querySelector('.best-move-dot')) {
                    const dot = document.createElement('div');
                    dot.className = 'best-move-dot';

                    const tooltip = document.createElement('div');
                    tooltip.className = 'best-move-tooltip';

                    const content = document.createElement('div');
                    content.className = 'tooltip-content';

                    if (guessData.mafs && guessData.mafs.length > 0) {
                        const mafDiv = document.createElement('div');
                        mafDiv.className = 'tooltip-row mafs';
                        mafDiv.innerHTML = `
                            <span class="role-label">Черные</span>
                            <span class="numbers">${guessData.mafs.map(pos => `<span class="number">${pos}</span>`).join('')}</span>
                        `;
                        content.appendChild(mafDiv);
                    }
                    
                    if (guessData.civs && guessData.civs.length > 0) {
                        const civDiv = document.createElement('div');
                        civDiv.className = 'tooltip-row civs';
                        civDiv.innerHTML = `
                            <span class="role-label">Мирные</span>
                            <span class="numbers">${guessData.civs.map(pos => `<span class="number">${pos}</span>`).join('')}</span>
                        `;
                        content.appendChild(civDiv);
                    }
                    
                    if (guessData.vice !== undefined) {
                        // Определяем роль игрока с номером vice
                        const vicePlayer = document.querySelector(`.cell[data-player="${guessData.vice}"]`);
                        let roleClass = '';
                        if (vicePlayer) {
                            if (vicePlayer.querySelector('.mafia-vote')) {
                                roleClass = 'mafs';
                            } else if (vicePlayer.querySelector('.sheriff-vote')) {
                                roleClass = 'sheriff';
                            } else {
                                roleClass = 'civs';
                            }
                        }
                        
                        const viceDiv = document.createElement('div');
                        viceDiv.className = `tooltip-row ${roleClass}`;
                        viceDiv.innerHTML = `
                            <span class="role-label">Руль</span>
                            <span class="numbers"><span class="number">${guessData.vice}</span></span>
                        `;
                        content.appendChild(viceDiv);
                    }

                    tooltip.appendChild(content);
                    playerCell.appendChild(dot);
                    playerCell.appendChild(tooltip);
                }
            }
        });
    }

    findShotNight(playerPosition, gameData) {
        console.log(`Finding shot night for player ${playerPosition}`);
        const shots = gameData.data?.shots || [];
        const mafiaPlayers = gameData.data?.players.filter(p => p.role === 1 || p.role === 0).map(p => p.position) || [];
        
        // Группируем выстрелы по ночам
        const shotsByNight = {};
        shots.forEach(shot => {
            if (shot.victim === playerPosition) {
                console.log(`Found shot at night ${shot.night} from ${shot.shooter}`);
                if (!shotsByNight[shot.night]) {
                    shotsByNight[shot.night] = new Set();
                }
                shotsByNight[shot.night].add(shot.shooter);
            }
        });
        
        console.log('Shots by night:', shotsByNight);
        console.log('Mafia players:', mafiaPlayers);
        
        // Находим самую позднюю ночь, когда все мафы стреляли в игрока
        const nights = Object.keys(shotsByNight).map(Number).sort((a, b) => b - a); // Сортируем ночи по убыванию
        
        for (const night of nights) {
            const shooters = shotsByNight[night];
            console.log(`Checking night ${night}, shooters:`, shooters);
            
            // Проверяем, все ли мафы стреляли
            if (shooters.size === mafiaPlayers.length) {
                console.log(`Found kill night: ${night}`);
                return night;
            }
        }
        
        // Если не нашли ночь, когда все мафы стреляли вместе,
        // возвращаем самую позднюю ночь, когда в игрока стреляли
        if (nights.length > 0) {
            console.log(`Returning last shot night: ${nights[0]}`);
            return nights[0];
        }
        
        console.log('No kill night found');
        return null;
    }

    addBestMoveStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .best-move-dot {
                width: 8px;
                height: 8px;
                background-color: #3b82f6;
                border-radius: 50%;
                position: absolute;
                top: 5px;
                right: 5px;
                z-index: 10;
                transition: transform 0.2s ease;
            }

            .best-move-dot:hover {
                transform: scale(1.2);
            }

            .best-move-tooltip {
                display: none;
                position: absolute;
                background: linear-gradient(180deg, rgba(30, 31, 34, 0.98) 0%, rgba(22, 23, 26, 0.98) 100%);
                color: white;
                padding: 10px 14px;
                border-radius: 10px;
                font-size: 13px;
                line-height: 1.5;
                white-space: pre-line;
                z-index: 1000;
                pointer-events: none;
                top: -10px;
                right: 25px;
                min-width: 160px;
                box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
                border: 1px solid rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(10px);
                transform-origin: right center;
                animation: tooltipAppear 0.2s ease;
            }

            .best-move-tooltip::before {
                content: '';
                position: absolute;
                right: -6px;
                top: 12px;
                width: 10px;
                height: 10px;
                background: inherit;
                transform: rotate(45deg);
                border-right: 1px solid rgba(255, 255, 255, 0.1);
                border-top: 1px solid rgba(255, 255, 255, 0.1);
                z-index: -1;
            }

            .best-move-tooltip::after {
                content: '';
                display: block;
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                margin-bottom: 8px;
            }

            .tooltip-content {
                display: flex;
                flex-direction: column;
                gap: 6px;
            }

            .tooltip-content::before {
                content: 'Лучший ход';
                display: block;
                font-size: 11px;
                color: rgba(255, 255, 255, 0.7);
                text-transform: uppercase;
                letter-spacing: 0.5px;
                margin-bottom: 8px;
            }

            .tooltip-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
            }

            .role-label {
                color: rgba(255, 255, 255, 0.7);
                font-size: 12px;
            }

            .numbers {
                display: flex;
                gap: 4px;
            }

            .number {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                min-width: 20px;
                height: 20px;
                padding: 0 4px;
                border-radius: 4px;
                font-weight: 500;
                font-size: 12px;
            }

            .mafs .number {
                background: rgba(59, 130, 246, 0.2);
                color: #3b82f6;
            }

            .civs .number {
                background: rgba(239, 68, 68, 0.1);
                color: #ef4444;
            }

            .sheriff .number {
                background: rgba(234, 179, 8, 0.2);
                color: #eab308;
            }

            .vice .number {
                background: rgba(147, 51, 234, 0.2);
                color: #9333ea;
            }

            .best-move-dot:hover + .best-move-tooltip {
                display: block;
            }

            .cell {
                position: relative !important;
            }
        `;
        document.head.appendChild(style);
    }

    // Метод для поиска дня, когда игрока заголосовали
    findVotedDay(playerPosition, gameData) {
        const votes = gameData.data?.votes || [];
        let maxDay = null;
        let maxVotes = 0;
        
        // Считаем голоса по дням
        const dayVotes = {};
        votes.forEach(vote => {
            if (vote.candidate === playerPosition && vote.num === 1) {
                dayVotes[vote.day] = (dayVotes[vote.day] || 0) + 1;
            }
        });
        
        // Находим день с максимальным количеством голосов
        Object.entries(dayVotes).forEach(([day, count]) => {
            if (count > maxVotes) {
                maxVotes = count;
                maxDay = parseInt(day);
            }
        });
        
        return maxDay;
    }

    getPlayerIdFromColumn(columnIndex, gameData) {
        const players = gameData.data?.players || [];
        return players[columnIndex - 1]?.position;
    }

    getPlayerName(id, gameData) {
        const players = gameData.players || [];
        const player = players.find(p => p.position === id);
        return player ? player.username : 'Unknown';
    }

    addStyles() {
        const existingStyles = document.querySelector('#match-enhancer-styles');
        if (existingStyles) {
            existingStyles.remove();
        }
    
        const style = document.createElement('style');
        style.id = 'match-enhancer-styles';
        style.textContent = `
            .game-stats-header {
                display: flex !important;
                justify-content: space-between !important;
                align-items: center !important;
                padding: 16px 24px !important;
                margin-bottom: 16px !important;
            }
            
            /* Удаляем дублирующие стили для точек */
            .best-move-dot,
            .best-move-dot:hover::after {
                display: none !important;
            }
            
            .header-info {
                font-size: 18px !important;
                color: #fff !important;
                font-weight: 400 !important;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
            }
        `;
        document.head.appendChild(style);
    }
    getActionIcon(type) {
        switch (type) {
            case 'kill': return '<img src="https://images.vexels.com/media/users/3/136961/isolated/lists/939659c2bb1b5e619a537af30d3a5849-target-icon.png" alt="Target" style="width: 16px; height: 16px; vertical-align: middle;">';
            case 'check': return '<img src="https://img.icons8.com/ios7/200/FFFFFF/search.png" alt="Magnifying Glass" style="width: 16px; height: 16px; vertical-align: middle;">';
            case 'don_check': return '<img src="https://cdn-icons-png.flaticon.com/512/3296/3296104.png" alt="Eye" style="width: 16px; height: 16px; vertical-align: middle;">';
            case 'vote': return '<img src="https://img.icons8.com/ios_filled/512/FFFFFF/search.png" alt="Thumbs Up" style="width: 16px; height: 16px; vertical-align: middle;">';
            default: return '<img src="https://cdn-icons-png.flaticon.com/512/271/271228.png" alt="Arrow" style="width: 16px; height: 16px; vertical-align: middle;">';
        }
    }

    processGamePhases(gameDetails) {
        console.log('Processing game phases, data:', gameDetails);
        
        const votes = gameDetails.votes || [];
        const shots = gameDetails.shots || [];
        const checks = gameDetails.checks || [];

        // Find don and sheriff players
        const donPlayer = gameDetails.players.find(p => p.role === 0)?.position;
        const sheriffPlayer = gameDetails.players.find(p => p.role === 3)?.position;

        // Initialize phases array
        const maxDay = Math.max(
            ...votes.map(v => v.day || 0),
            ...shots.map(s => s.night || 0),
            ...checks.map(c => c.night || 0)
        );
        
        const phases = Array.from(
            { length: maxDay }, 
            () => ({ day: [], night: [] })
        );

        // Парсим голосования с num === 1
        votes.forEach(vote => {
            if (vote.day && vote.day > 0 && vote.num === 1) {
                // Подсчитаем голоса за каждого игрока в этот день
                const dayVotes = votes.filter(v => v.day === vote.day && v.num === 1);
                const voteCount = {};
                dayVotes.forEach(v => {
                    voteCount[v.candidate] = (voteCount[v.candidate] || 0) + 1;
                });
                
                // Найдем максимальное количество голосов
                const maxVotes = Math.max(...Object.values(voteCount));
                
                phases[vote.day - 1].day.push({
                    type: 'vote',
                    from: vote.voter,
                    to: vote.candidate,
                    isLeading: voteCount[vote.candidate] === maxVotes,
                    num: 1
                });
            }
        });

        // Парсим голосования с num === 2
        votes.forEach(vote => {
            if (vote.day && vote.day > 0 && vote.num === 2) {
                // Подсчитаем голоса за каждого игрока в этот день
                const dayVotes = votes.filter(v => v.day === vote.day && v.num === 2);
                const voteCount = {};
                dayVotes.forEach(v => {
                    voteCount[v.candidate] = (voteCount[v.candidate] || 0) + 1;
                });
                
                // Найдем максимальное количество голосов
                const maxVotes = Math.max(...Object.values(voteCount));
                
                phases[vote.day - 1].day.push({
                    type: 'vote',
                    from: vote.voter,
                    to: vote.candidate,
                    isLeading: voteCount[vote.candidate] === maxVotes,
                    num: 2
                });
            }
        });

        // Process shots (mafia kills)
        shots.forEach(shot => {
            if (shot.night && shot.night > 0) {
                phases[shot.night - 1].night.push({
                    type: 'kill',
                    from: shot.shooter,
                    to: shot.victim
                });
            }
        });

        // Process checks (sheriff/don checks)
        checks.forEach(check => {
            if (check.night && check.night > 0) {
                phases[check.night - 1].night.push({
                    type: check.role === 0 ? 'don_check' : 'check',
                    from: check.role === 0 ? donPlayer : sheriffPlayer,
                    to: check.player
                });
            }
        });

        console.log('Processed phases:', phases);
        return phases;
    }

    addPenaltyIndicators(table, gameData) {
        const players = gameData.data?.players || [];
        
        players.forEach(player => {
            if (player.penalties?.length > 0) {
                player.penalties.forEach(penalty => {
                    const playerPosition = penalty.player;
                    const day = penalty.stage.day;
                    const type = penalty.type;
                    
                    // Получаем ник инициатора
                    const initiatorName = gameData.data.players.find(p => p.position === parseInt(penalty.initiator))?.username;
                    
                    // Формируем текст подсказки с никами
                    let tooltipText = '';
                    const initiator = `Инициатор: ${penalty.initiator} ${initiatorName}\n`;
                    const votes = Object.entries(penalty.votes)
                        .map(([voter, vote]) => {
                            const voterName = gameData.data.players.find(p => p.position === parseInt(voter))?.username;
                            return `${voter} ${voterName}: ${vote ? '✓' : '✗'}`;
                        })
                        .join('\n');
                    
                    switch(type) {
                        case 'disqual':
                            tooltipText = `Дисквалификация\n${initiator}${votes}`;
                            break;
                        case 'stop':
                            tooltipText = `ППК\n${initiator}${votes}`;
                            break;
                        case 'tech':
                            tooltipText = `ТЕХ.ФОЛ\n${initiator}${votes}`;
                            break;
                    }
                    
                    const color = type === 'tech'
                        ? '#FFD700'
                        : (type === 'stop' ? '#ef4444' : 'rgba(239, 68, 68, 0.45)');
                    const votePairs = Object.entries(penalty.votes || {})
                        .sort(([a], [b]) => parseInt(a, 10) - parseInt(b, 10))
                        .map(([voter, vote]) => `${voter}:${vote ? 1 : 0}`)
                        .join(',');
                    const penaltyKey = `${day}|${type}|${penalty.initiator}|${playerPosition}|${votePairs}`;
                    this.addPenaltyDot(table, playerPosition, day, color, tooltipText, penaltyKey);
                });
            }
        });
    }

    addPenaltyDot(table, playerPosition, day, color, tooltipText, penaltyKey) {
        console.log(`Adding penalty dot: player=${playerPosition}, day=${day}, color=${color}`);
        const rows = table.querySelectorAll('.row');
        
        rows.forEach(row => {
            const phaseCell = row.querySelector('.cell.title');
            const phaseText = phaseCell?.textContent || '';
            console.log('Checking row with phase:', phaseText);
            
            if (phaseText.includes(`${day} ☀️`)) {
                console.log('Found matching day row');
                const playerCell = row.querySelector(`.cell[data-player="${playerPosition}"]`);
                console.log('Found player cell:', playerCell);
                
                if (playerCell) {
                    let dotContainer = playerCell.querySelector('.penalty-dots');
                    if (!dotContainer) {
                        dotContainer = document.createElement('div');
                        dotContainer.className = 'penalty-dots';
                        dotContainer.style.position = 'absolute';
                        dotContainer.style.top = '5px';
                        dotContainer.style.left = '5px';
                        dotContainer.style.zIndex = '10';
                        dotContainer.style.display = 'inline-flex';
                        dotContainer.style.gap = '3px';
                        playerCell.style.position = 'relative';
                        playerCell.appendChild(dotContainer);
                    }

                    if (penaltyKey && dotContainer.querySelector(`.penalty-dot[data-penalty-key="${CSS.escape(penaltyKey)}"]`)) {
                        return;
                    }

                    console.log('Adding dot to cell');
                    const dot = document.createElement('div');
                    dot.className = 'penalty-dot';
                    if (penaltyKey) dot.setAttribute('data-penalty-key', penaltyKey);
                    dot.title = tooltipText;
                    dot.style.width = '8px';
                    dot.style.height = '8px';
                    dot.style.backgroundColor = color;
                    dot.style.borderRadius = '50%';
                    dot.style.cursor = 'pointer';
                    dot.style.display = 'block';
                    
                    dotContainer.appendChild(dot);
                    console.log('Dot added successfully');
                }
            }
        });
    }
}

// Initialize when on match page
if (window.location.pathname.includes('/match/')) {
    console.log('Match page detected, initializing enhancer...');
    
    // Добавляем функцию для определения data-v атрибута и установки стилей
    const applyAutoHeight = () => {
        // Находим элемент с классом game-stats-table
        const gameStatsTable = document.querySelector('.game-stats-table');
        if (gameStatsTable) {
            // Получаем все атрибуты элемента
            const attributes = gameStatsTable.attributes;
            // Ищем атрибут data-v-*
            let dataVAttribute = null;
            for (let i = 0; i < attributes.length; i++) {
                if (attributes[i].name.startsWith('data-v-')) {
                    dataVAttribute = attributes[i].name;
                    break;
                }
            }
            
            // Если нашли data-v атрибут, применяем стили
            if (dataVAttribute) {
                console.log(`Found data-v attribute: ${dataVAttribute}`);
                const styleElement = document.createElement('style');
                styleElement.textContent = `
                    [${dataVAttribute}] {
                        height: auto !important;
                    }
                `;
                document.head.appendChild(styleElement);
            }
            
            // В любом случае применяем стили к самому элементу
            gameStatsTable.style.height = 'auto';
            
            // Также ищем родительские элементы со скроллом и исправляем их
            let parent = gameStatsTable.parentElement;
            while (parent) {
                const computedStyle = window.getComputedStyle(parent);
                if (computedStyle.overflow.includes('scroll') || 
                    computedStyle.overflowY === 'scroll' || 
                    parent.classList.contains('__vuescroll') ||
                    parent.classList.contains('__panel') ||
                    parent.classList.contains('__view')) {
                    parent.style.height = 'auto';
                    parent.style.maxHeight = 'none';
                }
                parent = parent.parentElement;
            }
            
            // Найдем строки с итогами и MMR
            const tableRows = gameStatsTable.querySelectorAll('.row');
            if (tableRows.length >= 2) {
                // Последние две строки - это MMR и Итог
                const mmrRow = tableRows[tableRows.length - 1];
                const totalRow = tableRows[tableRows.length - 2];
                
                if (mmrRow && totalRow) {
                    // Упрощенные прямые стили без анимаций и эффектов
                    
                    // Строка MMR
                    mmrRow.setAttribute('style', 'background: #1a1c29 !important; border-bottom: 2px solid #2c3347 !important;');
                    
                    // Строка Итог
                    totalRow.setAttribute('style', 'background: #1a1c29 !important; border-top: 2px solid #2c3347 !important;');
                    
                    // Заголовки
                    const mmrTitle = mmrRow.querySelector('.cell.title');
                    const totalTitle = totalRow.querySelector('.cell.title');
                    
                    if (mmrTitle && totalTitle) {
                        mmrTitle.setAttribute('style', 'background: #151824 !important; font-weight: 700 !important; color: #d1d5db !important;');
                        totalTitle.setAttribute('style', 'background: #151824 !important; font-weight: 700 !important; color: #d1d5db !important;');
                    }
                    
                    // Ячейки итогов
                    totalRow.querySelectorAll('.cell:not(.title)').forEach(cell => {
                        const valueText = cell.textContent.trim();
                        const value = parseFloat(valueText) || 0;
                        
                        if (value > 0) {
                            cell.setAttribute('style', 'color: #10b981 !important; font-weight: 600 !important; font-size: 16px !important;');
                        } else if (value < 0) {
                            cell.setAttribute('style', 'color: #ef4444 !important; font-weight: 600 !important; font-size: 16px !important;');
                        } else {
                            cell.setAttribute('style', 'color: #94a3b8 !important; font-weight: 600 !important; font-size: 16px !important;');
                        }
                    });
                    
                    // Ячейки MMR
                    mmrRow.querySelectorAll('.cell:not(.title)').forEach(cell => {
                        const valueText = cell.textContent.trim();
                        const value = parseInt(valueText) || 0;
                        
                        if (value > 0) {
                            cell.setAttribute('style', 'color: #10b981 !important; font-weight: 700 !important; font-size: 17px !important;');
                        } else if (value < 0) {
                            cell.setAttribute('style', 'color: #ef4444 !important; font-weight: 700 !important; font-size: 17px !important;');
                        } else {
                            cell.setAttribute('style', 'color: #94a3b8 !important; font-weight: 700 !important; font-size: 17px !important;');
                        }
                    });
                }
            }
        }
    };
    
    // Запускаем функцию при загрузке страницы один раз
    window.addEventListener('load', applyAutoHeight);
    
    // И делаем только одно периодическое обновление с большим интервалом
    // вместо нескольких параллельных процессов
    let updateInterval;
    window.addEventListener('load', () => {
        // Сначала применяем стили
        applyAutoHeight();
        
        // Затем устанавливаем обновление с интервалом в 5 секунд
        clearInterval(updateInterval);
        updateInterval = setInterval(applyAutoHeight, 5000);
    });
    
    const style = document.createElement('style');
    style.textContent = `
        .game-stats-header[data-v-33ae8458] {
            background: rgba(45, 48, 57, .03) !important;
        }

        .table .row .cell.username[data-v-1db9d42a],
        .table .row .cell.title[data-v-1db9d42a],
        .table .row .cell.position[data-v-1db9d42a] {
            background: rgba(45, 48, 57, .03) !important;
        }
  .table .row .cell.sum[data-v-1db9d42a],
    .table .row .cell.mmr_diff[data-v-1db9d42a] {
        background: rgba(45, 48, 57, .09) !important;
    }
    
    .cell.mmr_diff[data-v-1db9d42a] {
        font-weight: 500;
    }

    .cell.mmr_diff[data-v-1db9d42a] span {
        padding: 4px 8px;
        border-radius: 4px;
    }

    .cell.mmr_diff[data-v-1db9d42a] span[style*="color: rgb(239, 68, 68)"] {
        background: rgba(239, 68, 68, 0.1);
    }

    .cell.mmr_diff[data-v-1db9d42a] span[style*="color: rgb(34, 197, 94)"] {
        background: rgba(34, 197, 94, 0.1);
    }

    .cell.mmr_diff[data-v-1db9d42a] span[style*="color: rgb(255, 255, 255)"] {
        background: rgba(255, 255, 255, 0.1);
    }

    .cell.sum[data-v-1db9d42a] {
        font-weight: 500;
    }

    .cell.sum[data-v-1db9d42a] span {
        padding: 4px 8px;
        border-radius: 4px;
    }

    .cell.sum[data-v-1db9d42a] span:not([style]) {
        background: rgba(255, 255, 255, 0.1);
        color: #ffffff;
    }

    .cell.sum[data-v-1db9d42a] span[style*="color: rgb(239, 68, 68)"] {
        background: rgba(239, 68, 68, 0.1);
    }

    .cell.sum[data-v-1db9d42a] span[style*="color: rgb(34, 197, 94)"] {
        background: rgba(34, 197, 94, 0.1);
    }

    .table .row .cell.mmr_diff[data-v-1db9d42a] > span,
    .table .row .cell.sum[data-v-1db9d42a] > span {
        padding: 0.5rem 1rem;
        border-radius: 8px;
        font-size: 0.875rem;
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        border: 1px solid;
    }

    .table .row .cell.mmr_diff[data-v-1db9d42a] > span[style*="color: rgb(239, 68, 68)"],
    .table .row .cell.sum[data-v-1db9d42a] > span[style*="color: rgb(239, 68, 68)"] {
        background: rgba(239, 68, 68, 0.1);
        border-color: rgba(239, 68, 68, 0.3);
    }

    .table .row .cell.mmr_diff[data-v-1db9d42a] > span[style*="color: rgb(34, 197, 94)"],
    .table .row .cell.sum[data-v-1db9d42a] > span[style*="color: rgb(34, 197, 94)"] {
        background: rgba(34, 197, 94, 0.15);
        border-color: rgba(34, 197, 94, 0.3);
    }

    .table .row .cell.mmr_diff[data-v-1db9d42a] > span[style*="color: rgb(255, 255, 255)"],
    .table .row .cell.sum[data-v-1db9d42a] > span[style*="color: rgb(255, 255, 255)"],
    .table .row .cell.mmr_diff[data-v-1db9d42a] > span:not([style]),
    .table .row .cell.sum[data-v-1db9d42a] > span:not([style]) {
        background: rgba(255, 255, 255, 0.1);
        border-color: rgba(255, 255, 255, 0.2);
    }
    
    .table .row .cell.mmr_diff[data-v-1db9d42a] span,
    .table .row .cell.sum[data-v-1db9d42a] span {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        min-width: 45px !important;
        padding: 4px 8px !important;
        border-radius: 6px !important;
        font-weight: 500 !important;
    }

    .table .row .cell.mmr_diff[data-v-1db9d42a] span[style*="color: #ef4444"],
    .table .row .cell.sum[data-v-1db9d42a] span[style*="color: #ef4444"] {
        background: rgba(239, 68, 68, 0.15) !important;
        border: 1px solid rgba(239, 68, 68, 0.3) !important;
    }

    .table .row .cell.mmr_diff[data-v-1db9d42a] span[style*="color: #22c55e"],
    .table .row .cell.sum[data-v-1db9d42a] span[style*="color: #22c55e"] {
        background: rgba(34, 197, 94, 0.15) !important;
        border: 1px solid rgba(34, 197, 94, 0.3) !important;
    }

    .table .row .cell.mmr_diff[data-v-1db9d42a] span[style*="color: #ffffff"],
    .table .row .cell.sum[data-v-1db9d42a] span[style*="color: #ffffff"] {
        background: rgba(255, 255, 255, 0.1) !important;
        border: 1px solid rgba(255, 255, 255, 0.2) !important;
    }
    
    [style*="overflow: scroll hidden"] {
        overflow: hidden !important;
    }
        [data-v-33ae8458] { height: auto !important; }
        .__vuescroll { height: auto !important; }
        .__panel, .__view {
            height: auto !important;
        }
        
        /* Добавляем автоматическую высоту для контейнера с итогами */
   
        
        .game-stats-table {
            background: rgba(0, 0, 0, 0.2);
            border-radius: 16px;
            overflow: hidden;
            border: 1px solid rgba(255, 255, 255, 0.05);
            border-collapse: collapse;
            color: var(--primary-white);
            font-family: var(--font-family);
        }
        
        /* Улучшенные стили для строк с итогом и MMR */
        .table .row:nth-last-child(1), 
        .table .row:nth-last-child(2) {
            background: rgba(22, 23, 35, 0.98) !important;
            border-top: 1px solid rgba(255, 255, 255, 0.15) !important;
            border-bottom: 1px solid rgba(255, 255, 255, 0.15) !important;
        }
        
        /* Стиль для строки "Итог" */
        .table .row:nth-last-child(2) .cell:not(.title) {
            font-weight: 600 !important;
            font-size: 15px !important;
            color: #ffffff !important;
            text-shadow: 0 0 5px rgba(255, 255, 255, 0.2);
        }
        
        /* Стиль для строки MMR */
        .table .row:nth-last-child(1) .cell:not(.title) {
            font-weight: 700 !important;
            font-size: 16px !important;
        }
        
        /* Стили для положительных значений MMR */
        .table .row:nth-last-child(1) .cell:not(.title):has(span[style*="color: rgb(34, 197, 94)"]),
        .table .row:nth-last-child(1) .cell:not(.title) span[style*="+"] {
            color: #22c55e !important;
            text-shadow: 0 0 8px rgba(34, 197, 94, 0.4);
        }
        
        /* Стили для отрицательных значений MMR */
        .table .row:nth-last-child(1) .cell:not(.title):has(span[style*="color: rgb(239, 68, 68)"]),
        .table .row:nth-last-child(1) .cell:not(.title) span[style*="-"] {
            color: #ef4444 !important;
            text-shadow: 0 0 8px rgba(239, 68, 68, 0.4);
        }
        
        /* Добавляем зеленую подсветку снизу для высоких положительных итогов */
        .table .row:nth-last-child(2) .cell:not(.title):has(span[style*="color: rgb(34, 197, 94)"]) {
            border-bottom: 3px solid rgba(34, 197, 94, 0.7) !important;
        }
        
        /* Добавляем красную подсветку снизу для отрицательных итогов */
        .table .row:nth-last-child(2) .cell:not(.title):has(span[style*="color: rgb(239, 68, 68)"]) {
            border-bottom: 3px solid rgba(239, 68, 68, 0.7) !important;
        }
        
        /* Улучшаем отображение значений итогов */
        .table .row:nth-last-child(2) .cell:not(.title) {
            position: relative;
        }
        
        /* Добавляем цветные линии под ячейками итогов как на скриншоте */
        .table .row:nth-last-child(2) .cell:not(.title)::after {
            content: '';
            position: absolute;
            bottom: 0;
            left: 10%;
            width: 80%;
            height: 3px;
            background: linear-gradient(90deg, 
                rgba(255, 255, 255, 0.05) 0%, 
                rgba(255, 255, 255, 0.2) 50%, 
                rgba(255, 255, 255, 0.05) 100%);
            border-radius: 2px;
        }
        
        /* Цвет линии зависит от значения */
        .table .row:nth-last-child(2) .cell:not(.title):has(span[style*="color: rgb(34, 197, 94)"])::after {
            background: linear-gradient(90deg, 
                rgba(34, 197, 94, 0.3) 0%, 
                rgba(34, 197, 94, 0.8) 50%, 
                rgba(34, 197, 94, 0.3) 100%);
        }
        
        .table .row:nth-last-child(2) .cell:not(.title):has(span[style*="color: rgb(239, 68, 68)"])::after {
            background: linear-gradient(90deg, 
                rgba(239, 68, 68, 0.3) 0%, 
                rgba(239, 68, 68, 0.8) 50%, 
                rgba(239, 68, 68, 0.3) 100%);
        }
        
        /* Отключаем псевдоэлемент ::after для div.cell.player и div.cell.player.sum.winner.has-calcs */
        div.cell.player::after,
        div.cell.player.sum.winner.has-calcs::after {
            display: none !important;
            content: none !important;
        }
        
        /* Улучшенные стили для заголовков Итог и MMR */
        .table .row:nth-last-child(1) .cell.title,
        .table .row:nth-last-child(2) .cell.title {
            background: rgba(10, 10, 20, 0.8) !important;
            font-weight: 700 !important;
            color: #cbd5e1 !important;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .table .row[data-v-1db9d42a] {
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            background: rgba(20, 20, 35, 0.95);
        }
        .cell {
            padding: 1rem;
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
            min-height: 60px;
            background: transparent;
            border-right: 1px solid rgba(255, 255, 255, 0.1);
            color: #ffffff;
        }
        .cell:last-child {
            border-right: none;
        }
        .cell.title {
            background: rgba(0, 0, 0, 0.3);
            font-weight: 500;
            color: #94a3b8;
            width: 67px !important;
            min-width: 67px !important;
            flex: 0 0 67px !important;
        }
        .cell.player {
            text-align: center;
            width: 115px !important;
            min-width: 115px !important;
            flex: 0 0 115px !important;
        }
        .vote {
            padding: 0.5rem 1rem;
            border-radius: 8px;
            font-size: 0.875rem;
            transition: all 0.2s;
            color: #ffffff;
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            background: transparent;
            border: 1px solid rgba(255, 255, 255, 0.2);
        }
        .vote.leading {
            color: #ff3b30;
            border-color: rgba(255, 59, 48, 0.3);
        }
        .action {
            font-size: 12px;
            padding: 2px 4px;
            margin: 2px 0;
            border-radius: 4px;
            background: rgba(30, 30, 40, 0.5) !important;
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
            border-radius: 8px !important;
            padding: 2px 6px !important;
            display: inline-flex !important;
            flex-wrap: nowrap !important;
            justify-content: center !important;
            align-items: center !important;
            gap: 2px !important;
            min-height: auto !important;
            height: auto !important;
            margin: 2px !important;
        }
        .action:hover {
            background: rgba(40, 40, 50, 0.7) !important;
        }
        .action.kill {
            background: rgba(59, 130, 246, 0.2);
            color: #3b82f6;
        }
        .action.check {
            background: rgba(234, 179, 8, 0.2);
            color: #eab308;
        }
        .action.don_check {
            background: rgba(147, 51, 234, 0.2);
            color: #9333ea;
        }
        .action.vote {
            background: rgba(30, 30, 40, 0.5) !important;
            color: #ffffff;
        }
        .action.vote.leading .voter {
            background: rgba(59, 130, 246, 0.2);
        }
        .action.kill img {
            width: 16px;
            height: 16px;
            vertical-align: middle;
            margin-right: 2px;
            filter: brightness(1.2);
        }
        
        /* Добавляем стили для голосования */
        .voter { color: #ef4444 !important; }
        .voter.don-vote { color: #9333ea !important; }
        .voter.mafia-vote { color: white !important; }
        .voter.sheriff-vote { color: #eab308 !important; }
        
        /* Улучшаем отображение голосов */
        .action span.voter {
            display: inline-block;
            margin: 0;
            padding: 0;
            background: transparent;
            font-size: 14px;
            font-weight: 500;
        }
        
        /* Стиль для контейнера голосов как на скриншоте */
        .action {
            background: rgba(30, 30, 40, 0.5) !important;
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
            border-radius: 8px !important;
            padding: 2px 6px !important;
            display: inline-flex !important;
            flex-wrap: nowrap !important;
            justify-content: center !important;
            align-items: center !important;
            gap: 2px !important;
            min-height: auto !important;
            height: auto !important;
            margin: 2px !important;
        }
        
        /* Стили для ячеек, чтобы контейнеры голосов были по центру */
        .cell.player.role {
            display: flex;
            flex-direction: row;
            flex-wrap: wrap;
            align-items: center;
            justify-content: center;
            gap: 4px;
        }
    `;
    document.head.appendChild(style);

    new MatchEnhancer();
}
    // Wait for the page to be fully loaded
    window.addEventListener('load', () => {
        // Create script element
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/gh/your-username/match-enhancer/match-enhancer.js';
        // Or use direct injection:
        script.textContent = `
            ${MatchEnhancer.toString()}
            console.log('Match enhancer injected');
            new MatchEnhancer();
        `;
        document.head.appendChild(script);

        // Add styles
        const style = document.createElement('style');
        style.textContent = `
            .voter { color: #ef4444 !important; }
            .voter.don-vote { color: #9333ea !important; }
            .voter.mafia-vote { color: white !important; }
            .voter.sheriff-vote { color: #eab308 !important; }
            
            .cell.player img {
                width: 26px;
                height: 26px;
            }
            .action {
                font-size: 12px;
                background: rgba(30, 30, 40, 0.5) !important;
                border: 1px solid rgba(255, 255, 255, 0.1) !important;
                border-radius: 8px !important;
                padding: 2px 6px !important;
                display: inline-flex !important;
                flex-wrap: nowrap !important;
                justify-content: center !important;
                align-items: center !important;
                gap: 2px !important;
                min-height: auto !important;
                height: auto !important;
                margin: 2px !important;
            }
            .action:hover {
                background: rgba(40, 40, 50, 0.7) !important;
            }
            .action.kill {
                background: rgba(59, 130, 246, 0.2) !important;
                color: #3b82f6;
            }
            .action.check {
                background: rgba(234, 179, 8, 0.2) !important;
                color: #eab308;
            }
            .action.don_check {
                background: rgba(147, 51, 234, 0.2) !important;
                color: #9333ea;
            }
            .action.vote {
                background: rgba(30, 30, 40, 0.5) !important;
                color: #ffffff;
            }
            .action span.voter {
                display: inline-block;
                margin: 0;
                padding: 0;
                background: transparent;
                font-size: 14px;
                font-weight: 500;
            }
            .action.kill img {
                width: 16px;
                height: 16px;
                vertical-align: middle;
                margin-right: 2px;
                filter: brightness(1.2);
            }
        `;
        document.head.appendChild(style);
    });
