// ==UserScript==
// @name         Rotate Mafia Game Videos with Toggle Mode 
// @namespace    http://tampermonkey.net/
// @version      1.15
// @description  Flip player video using canvas when clicked in rotation mode on polemicagame.com, preserving player order with video state monitoring
// @author       fjfalcon with Grok
// @match        *://polemicagame.com/game
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    let isRotationModeEnabled = false;

    // Создаем кнопку для переключения режима
    const toggleButton = document.createElement('button');
    toggleButton.textContent = 'Включить режим поворота';
    toggleButton.style.position = 'fixed';
    toggleButton.style.top = '10px';
    toggleButton.style.right = '10px';
    toggleButton.style.zIndex = '10000';
    toggleButton.style.padding = '10px';
    toggleButton.style.backgroundColor = '#4CAF50';
    toggleButton.style.color = 'white';
    toggleButton.style.border = 'none';
    toggleButton.style.borderRadius = '5px';
    toggleButton.style.cursor = 'pointer';
    document.body.appendChild(toggleButton);

    // Функция для обновления текста и стиля кнопки
    function updateButton() {
        toggleButton.textContent = isRotationModeEnabled ? 'Выключить режим поворота' : 'Включить режим поворота';
        toggleButton.style.backgroundColor = isRotationModeEnabled ? '#f44336' : '#4CAF50';
    }

    // Обработчик клика по кнопке
    toggleButton.addEventListener('click', () => {
        isRotationModeEnabled = !isRotationModeEnabled;
        updateButton();
    });

    // Функция для переворота видео с помощью canvas
    function toggleCanvasFlip(player) {
        if (!isRotationModeEnabled) {
            return;
        }
        const wrapper = player.querySelector('.player__video-wrapper');
        const video = wrapper ? wrapper.querySelector('video.player__video') : null;
        const playerId = player.dataset.playerId || `player_${Math.random().toString(36).substr(2, 9)}`;
        player.dataset.playerId = playerId;
        const originalOrder = player.style.order || getComputedStyle(player).order;
        player.dataset.originalOrder = originalOrder;

        if (!video) {
            return;
        }

        // Добавляем обработчики событий pause и play
        video.addEventListener('pause', () => {}, { once: true });
        video.addEventListener('play', () => {}, { once: true });

        if (video.dataset.flipped === 'true') {
            // Восстанавливаем оригинальное видео
            const canvas = wrapper.querySelector('canvas');
            if (canvas) {
                canvas.remove();
            }
            video.style.opacity = '1';
            video.dataset.flipped = 'false';
        } else {
            // Проверяем, готово ли видео
            if (video.readyState < 2) {
                video.play().catch(() => {});
            }

            // Создаем canvas
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth || 1280;
            canvas.height = video.videoHeight || 720;
            canvas.style.width = '100%';
            canvas.style.height = '100%';
            canvas.style.position = 'absolute';
            canvas.style.top = '0';
            canvas.style.left = '0';
            wrapper.appendChild(canvas);
            video.style.opacity = '0'; // Скрываем видео, но оставляем display: block

            const ctx = canvas.getContext('2d');
            ctx.scale(-1, -1); // Переворот на 180 градусов
            ctx.translate(-canvas.width, -canvas.height);

            function drawFrame() {
                if (video.paused || video.ended) {
                    return;
                }
                try {
                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                    requestAnimationFrame(drawFrame);
                } catch (error) {}
            }

            video.addEventListener('play', () => {
                drawFrame();
            });

            if (!video.paused && video.readyState >= 2) {
                drawFrame();
            } else {
                video.play().catch(() => {});
            }

            video.dataset.flipped = 'true';
        }

        // Проверяем и восстанавливаем order
        if (player.style.order !== originalOrder) {
            player.style.order = originalOrder;
        }
    }

    // Глобальный обработчик кликов
    document.addEventListener('click', (e) => {
        const player = e.target.closest('.player');
        if (player) {
            toggleCanvasFlip(player);
        }
    }, { capture: true });

    // Функция для применения стилей
    function applyStylesToPlayers() {
        const players = document.querySelectorAll('.player');
        players.forEach((player, index) => {
            if (!player.dataset.rotationStyleApplied) {
                player.style.cursor = 'pointer';
                player.dataset.rotationStyleApplied = 'true';
                player.dataset.playerId = player.dataset.playerId || `player_${Math.random().toString(36).substr(2, 9)}`;
                const originalOrder = player.style.order || getComputedStyle(player).order;
                player.dataset.originalOrder = originalOrder;
            }
        });
    }

    // Вызываем функцию сразу
    applyStylesToPlayers();

    // Периодическая проверка order и состояния видео
    setInterval(() => {
        applyStylesToPlayers();
        const players = document.querySelectorAll('.player');
        players.forEach((player) => {
            const originalOrder = player.dataset.originalOrder;
            if (originalOrder && player.style.order !== originalOrder) {
                player.style.order = originalOrder;
            }
            const video = player.querySelector('video.player__video');
            if (video && video.dataset.flipped === 'true' && video.paused) {
                video.play().catch(() => {});
            }
        });
    }, 100); // Проверяем каждые 100 мс

    // Отслеживаем динамически добавленные .player
    const observer = new MutationObserver((mutations) => {
        let playerFound = false;
        mutations.forEach((mutation) => {
            if (mutation.addedNodes.length) {
                mutation.addedNodes.forEach((node) => {
                    if (node.classList && node.classList.contains('player')) {
                        playerFound = true;
                        if (!node.dataset.rotationStyleApplied) {
                            node.style.cursor = 'pointer';
                            node.dataset.rotationStyleApplied = 'true';
                            node.dataset.playerId = `player_${Math.random().toString(36).substr(2, 9)}`;
                            const originalOrder = node.style.order || getComputedStyle(node).order;
                            node.dataset.originalOrder = originalOrder;
                        }
                    } else if (node.querySelectorAll) {
                        const newPlayers = node.querySelectorAll('.player');
                        newPlayers.forEach((player) => {
                            if (!player.dataset.rotationStyleApplied) {
                                playerFound = true;
                                player.style.cursor = 'pointer';
                                player.dataset.rotationStyleApplied = 'true';
                                player.dataset.playerId = `player_${Math.random().toString(36).substr(2, 9)}`;
                                const originalOrder = player.style.order || getComputedStyle(player).order;
                                player.dataset.originalOrder = originalOrder;
                            }
                        });
                    }
                });
            }
        });
    });

    // Наблюдаем за изменениями в DOM
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // Инициализируем состояние кнопки
    updateButton();
})();
