class TooltipEnhancer {
    constructor() {
        this.initStyles();
        this.initMutationObserver();
        this.matchData = null;

        // Подписываемся на событие с данными матча
        document.addEventListener('gameDataParsed', (event) => {
            console.log('Game data received:', event.detail);
            this.matchData = event.detail;
        });
    }

    initPlayerMap() {
        // Ждем инициализации MatchEnhancer и получения данных матча
        const interval = setInterval(() => {
            const gameData = document.querySelector('script[type="application/json"]');
            if (gameData) {
                try {
                    const matchData = JSON.parse(gameData.textContent);
                    if (matchData.data && matchData.data.players) {
                        this.playerMap = new Map(
                            matchData.data.players.map(player => [
                                player.position,
                                player.username
                            ])
                        );
                        clearInterval(interval);
                        console.log('PlayerMap created:', this.playerMap);
                    }
                } catch (e) {
                    console.error('Failed to parse match data:', e);
                }
            }
        }, 100);
    }

    initStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .enhanced-tooltip {
                background: linear-gradient(180deg, rgba(45, 48, 57, 0.99), rgba(35, 38, 47, 0.99));
                border-radius: 8px;
                padding: 12px;
                min-width: 180px;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
                border: 1px solid rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(10px);
                font-family: 'Inter', -apple-system, sans-serif;
                position: fixed;
                z-index: 99999;
                color: #fff;
                pointer-events: all;
            }

            .enhanced-tooltip-title {
                color: #FF4B55;
                font-size: 14px;
                font-weight: 600;
                margin-bottom: 8px;
                padding-bottom: 8px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            }

            .enhanced-tooltip-content {
                color: #FFD700;
                font-size: 13px;
                padding: 4px 8px;
                background: rgba(255, 255, 255, 0.05);
                border-radius: 6px;
            }

            .enhanced-tooltip-initiator {
                color: #FFD700;
                font-size: 13px;
                margin-bottom: 8px;
                padding-bottom: 8px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            }

            .enhanced-tooltip-votes {
                display: grid;
                grid-template-columns: repeat(2, 1fr);
                gap: 6px;
            }

            .enhanced-tooltip-vote {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 4px 8px;
                background: rgba(255, 255, 255, 0.05);
                border-radius: 6px;
            }

            .vote-yes { color: #4CAF50; font-weight: bold; }
            .vote-no { color: #FF4B55; font-weight: bold; }

            .player-info {
                display: flex;
                align-items: center;
                gap: 6px;
                min-width: 100px;
            }

            .player-number {
                color: rgba(255, 255, 255, 0.5);
                font-size: 13px;
                min-width: 16px;
            }

            .player-name {
                color: rgba(255, 255, 255, 0.9);
                font-size: 13px;
                cursor: pointer;
                transition: color 0.2s ease;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .player-name:hover {
                color: #4CAF50;
            }

            .copy-notification {
                position: fixed;
                bottom: 20px;
                right: 20px;
                background: rgba(0, 0, 0, 0.8);
                color: white;
                padding: 8px 16px;
                border-radius: 4px;
                font-size: 14px;
                animation: notificationAppear 0.3s ease;
                z-index: 100000;
            }

            @keyframes notificationAppear {
                from {
                    opacity: 0;
                    transform: translateY(20px);
                }
                to {
                    opacity: 1;
                    transform: translateY(0);
                }
            }

            .enhanced-tooltip-vote {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 4px 8px;
                background: rgba(255, 255, 255, 0.05);
                border-radius: 6px;
                transition: background 0.2s ease;
                gap: 8px;
            }

            .enhanced-tooltip-vote:hover {
                background: rgba(255, 255, 255, 0.08);
            }
        `;
        document.head.appendChild(style);
    }

    initMutationObserver() {
        const observer = new MutationObserver((mutations) => {
            mutations.forEach(mutation => {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === 1) {
                        const dots = node.querySelectorAll('.penalty-dot, .best-move-dot');
                        dots.forEach(dot => this.enhanceTooltip(dot));
                    }
                });
            });
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    enhanceTooltip(element) {
        const originalTitle = element.getAttribute('title');
        if (!originalTitle) return;

        element.removeAttribute('title');
        let tooltipTimeout;

        element.addEventListener('mouseenter', (e) => {
            const tooltip = this.createTooltip(originalTitle, element.classList.contains('best-move-dot'), this.matchData);
            document.body.appendChild(tooltip);

            const rect = element.getBoundingClientRect();
            tooltip.style.position = 'fixed';
            tooltip.style.left = `${rect.left - 180}px`;
            tooltip.style.top = `${rect.top - tooltip.offsetHeight/2 + rect.height/2}px`;

            element.tooltip = tooltip;

            tooltip.addEventListener('mouseenter', () => {
                clearTimeout(tooltipTimeout);
            });

            tooltip.addEventListener('mouseleave', () => {
                tooltipTimeout = setTimeout(() => {
                    if (element.tooltip) {
                        element.tooltip.remove();
                        element.tooltip = null;
                    }
                }, 100);
            });
        });

        element.addEventListener('mouseleave', (e) => {
            tooltipTimeout = setTimeout(() => {
                if (element.tooltip && !element.tooltip.matches(':hover')) {
                    element.tooltip.remove();
                    element.tooltip = null;
                }
            }, 100);
        });
    }

    setMatchData(matchData) {
        this.matchData = matchData;
    }

    getPlayerName(number) {
        if (!this.matchData?.data?.players) {
            return `${number}`;
        }
        const name = this.matchData.data.players.find(p => p.position === parseInt(number))?.username;
        return name || `${number}`;
    }

    truncateName(name) {
        return name?.length > 6 ? name.substring(0, 6) + '...' : name;
    }

    getRoleColor(number) {
        if (!this.matchData?.data?.players) {
            console.log('No match data available');
            return 'white';
        }

        const player = this.matchData.data.players.find(p => p.position === parseInt(number));
        if (!player) {
            console.log(`Player ${number} not found`);
            return 'white';
        }

        console.log(`Player ${number} role:`, player.role); // Отладка

        switch(player.role) {
            case 3: return '#fbbf24';  // Шериф - желтый (#fbbf24)
            case 2: return '#ffffff';   // Мирный - белый (#ffffff)
            case 1: return '#0ea5e9';   // Мафия - синий (#0ea5e9)
            case 0: return '#ff3b30';   // Дон - красный (#ff3b30)
            default: return '#ffffff';
        }
    }

    createTooltip(content, isBestMove, matchData) {
        // Обновляем данные матча при каждом создании тултипа
        if (matchData) {
            this.setMatchData(matchData);
        }

        const tooltip = document.createElement('div');
        tooltip.className = 'enhanced-tooltip';

        if (isBestMove) {
            const match = content.match(/Лучший ход: (.+)/);
            if (!match) return tooltip;

            const numbers = match[1].split(/,\s*/).map(n => n.trim());
            
            tooltip.innerHTML = `
                <div class="enhanced-tooltip-title">Лучший ход</div>
                <div class="enhanced-tooltip-content">
                    ${numbers.map((num, idx) => {
                        const color = this.getRoleColor(num);
                        return `<span style="color: ${color}">${num}</span>${idx < numbers.length - 1 ? ', ' : ''}`;
                    }).join('')}
                </div>
            `;
        } else {
            const lines = content.split('\n');
            console.log('Tooltip content:', lines); // Отладка
            
            const title = lines[0];
            const initiatorMatch = lines[1].match(/Инициатор: (\d+)/);
            const initiatorNumber = initiatorMatch ? initiatorMatch[1] : '';
            const initiatorName = this.getPlayerName(initiatorNumber);

            tooltip.innerHTML = `
                <div class="enhanced-tooltip-title">${title}</div>
                <div class="enhanced-tooltip-initiator">
                    Инициатор: ${initiatorNumber} ${this.truncateName(initiatorName)}
                </div>
                <div class="enhanced-tooltip-votes">
                    ${lines.slice(2).map(vote => {
                        const [playerPart, result] = vote.split(': ');
                        const playerNumber = playerPart.match(/\d+/)[0];
                        const playerName = this.getPlayerName(playerNumber);
                        const isYes = result.includes('✓');
                        
                        return `
                            <div class="enhanced-tooltip-vote">
                                <div class="player-info">
                                    <span class="player-number">${playerNumber}</span>
                                    <span class="player-name" title="${playerName}" data-full-name="${playerName}">
                                        ${this.truncateName(playerName)}
                                    </span>
                                </div>
                                <span class="vote-icon ${isYes ? 'vote-yes' : 'vote-no'}">${isYes ? '✓' : '✗'}</span>
                            </div>
                        `;
                    }).join('')}
                </div>
            `;

            // Добавляем обработчики копирования
            tooltip.querySelectorAll('.player-name').forEach(nameEl => {
                nameEl.addEventListener('click', () => {
                    this.copyToClipboard(nameEl.dataset.fullName);
                });
            });
        }

        return tooltip;
    }

    copyToClipboard(text) {
        navigator.clipboard.writeText(text).then(() => {
            this.showNotification('Никнейм скопирован!');
        });
    }

    showNotification(message) {
        const notification = document.createElement('div');
        notification.className = 'copy-notification';
        notification.textContent = message;
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.remove();
        }, 2000);
    }
}

// Создаем один экземпляр для всех матчей
const tooltipEnhancer = new TooltipEnhancer(); 