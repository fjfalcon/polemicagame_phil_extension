// Проверяем, не добавлены ли уже стили
if (!document.getElementById('module-manager-styles')) {
    const style = document.createElement('style');
    style.id = 'module-manager-styles';
    style.textContent = `
        .modules-disabled .p-play__profile-games {
            display: none !important;
        }
    `;
    document.head.appendChild(style);
}

class ModuleManager {
    constructor() {
        this.isDisabled = false;
        this.init();
    }

    init() {
        // Проверяем сохраненное состояние
        chrome.storage.sync.get(['modulesDisabled'], (result) => {
            this.isDisabled = result.modulesDisabled === true;
            if (this.isDisabled) {
                this.removeModules();
            }
        });

        // Настраиваем наблюдатель за DOM
        this.observer = new MutationObserver((mutations) => {
            if (this.isDisabled) {
                this.removeModules();
            }
        });

        // Начинаем наблюдение
        this.observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // Слушаем сообщения
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (message.action === 'toggleModules') {
                this.isDisabled = message.isDisabled;
                
                if (this.isDisabled) {
                    this.removeModules();
                } else {
                    window.location.reload();
                }
                
                sendResponse({ success: true });
                return true;
            }
        });
    }

    removeModules() {
        // Находим контейнер с играми
        const gamesContainer = document.querySelector('.p-play__profile-games');
        if (gamesContainer) {
            // Удаляем все новые игры
            const newGames = gamesContainer.querySelectorAll('.p-play__profile-game:not([data-game="quiz"]):not([data-game="tic-tac-toe"])');
            newGames.forEach(game => game.remove());

            // Проверяем наличие старых игр
            const hasQuiz = gamesContainer.querySelector('[data-game="quiz"]');
            const hasTicTacToe = gamesContainer.querySelector('[data-game="tic-tac-toe"]');

            // Если старых игр нет, добавляем их
            if (!hasQuiz || !hasTicTacToe) {
                gamesContainer.innerHTML = `
                    <div class="p-play__profile-game" data-game="quiz" style="
                        background: rgba(255, 255, 255, 0.1);
                        border-radius: 8px;
                        padding: 10px;
                        cursor: pointer;
                        flex: 1;
                    ">
                        <div class="p-play__profile-game-title" style="
                            color: white;
                            font-size: 14px;
                            font-weight: 500;
                            margin-bottom: 4px;
                        ">Викторина</div>
                        <div class="p-play__profile-game-description" style="
                            color: rgba(255, 255, 255, 0.7);
                            font-size: 12px;
                        ">Проверь свои знания</div>
                    </div>
                    <div class="p-play__profile-game" data-game="tic-tac-toe" style="
                        background: rgba(255, 255, 255, 0.1);
                        border-radius: 8px;
                        padding: 10px;
                        cursor: pointer;
                        flex: 1;
                    ">
                        <div class="p-play__profile-game-title" style="
                            color: white;
                            font-size: 14px;
                            font-weight: 500;
                            margin-bottom: 4px;
                        ">Крестики-нолики</div>
                        <div class="p-play__profile-game-description" style="
                            color: rgba(255, 255, 255, 0.7);
                            font-size: 12px;
                        ">Сыграй в крестики-нолики</div>
                    </div>
                `;

                // Добавляем стили для контейнера
                gamesContainer.style.cssText = `
                    display: flex;
                    gap: 10px;
                    margin-top: 10px;
                `;
            }
        }
    }
}

// Создаем экземпляр менеджера
const moduleManager = new ModuleManager(); 