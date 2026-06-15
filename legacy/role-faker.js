console.log("Role Faker Script Loaded!");

class RoleFaker {
    constructor() {
        console.log("Initializing RoleFaker");
        this.roles = [
            { name: 'undefined', icon: 'player' },
            { name: 'Дон', icon: 'godfather' },
            { name: 'Мафия', icon: 'mafia' },
            { name: 'Шериф', icon: 'sheriff' },
            { name: 'Мирный', icon: 'civilian' }
        ];
        this.currentRoleIndex = 0;
        this.isEnabled = true;
        this.originalRoles = new Map(); // Сохраняем оригинальные состояния ролей
        this.isFaked = false; // Флаг для отслеживания состояния подмены
        this.originalStyles = new Map(); // Для сохранения оригинальных стилей меню
        this.keydownHandler = null;
        this.init();
    }

    resolveRoleSpriteBaseUrl() {
        if (this.roleSpriteBaseUrl !== undefined) return this.roleSpriteBaseUrl;

        const useElements = document.querySelectorAll('use[href], use[xlink\\:href]');
        const roleMarkers = ['#civilian', '#sheriff', '#mafia', '#godfather'];

        const hasInlineSprite = document.querySelector('symbol#civilian, symbol#sheriff, symbol#mafia, symbol#godfather');
        if (hasInlineSprite) {
            this.roleSpriteBaseUrl = '';
            return this.roleSpriteBaseUrl;
        }

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

    init() {
        // Удаляем старые обработчики при инициализации
        this.removeAllKeyHandlers();

        // Создаем основной обработчик клавиш
        this.keydownHandler = (e) => {
            if (!this.isEnabled) return;

            // Блокируем кнопку D/В если активен фейк
            if ((e.key.toLowerCase() === 'd' || e.key.toLowerCase() === 'в') && this.isFaked) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }

            if (e.key.toLowerCase() === 'f' || e.key.toLowerCase() === 'а') {
                console.log("F key pressed, attempting to change role");
                this.changeRole();
                this.hideOtherRoles();
                this.fixMenuPositions();
                this.isFaked = true;
            }

            if (e.key.toLowerCase() === 'e' || e.key.toLowerCase() === 'у') {
                console.log("E key pressed, resetting roles");
                this.resetRoles();
                this.resetMenuPositions();
                this.isFaked = false;
                // Принудительно очищаем все обработчики
                this.removeAllKeyHandlers();
                // Переустанавливаем основной обработчик
                this.setupKeyHandlers();
            }
        };

        this.setupKeyHandlers();

        chrome.storage.sync.get({ enable_role_faker: true }, (settings) => {
            this.isEnabled = settings.enable_role_faker;
            console.log(`Role Faker ${this.isEnabled ? 'enabled' : 'disabled'}`);
        });

        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (message.type === 'updateRoleFaker') {
                this.isEnabled = message.enabled;
                console.log(`Role Faker ${this.isEnabled ? 'enabled' : 'disabled'}`);
                if (!this.isEnabled && this.isFaked) {
                    this.resetRoles();
                    this.isFaked = false;
                }
            }
        });
    }

    setupKeyHandlers() {
        document.addEventListener('keydown', this.keydownHandler, true);
    }

    removeAllKeyHandlers() {
        if (this.keydownHandler) {
            document.removeEventListener('keydown', this.keydownHandler, true);
            document.removeEventListener('keydown', this.keydownHandler, false);
            window.removeEventListener('keydown', this.keydownHandler, true);
            window.removeEventListener('keydown', this.keydownHandler, false);
        }
        if (this.dKeyBlockerHandler) {
            document.removeEventListener('keydown', this.dKeyBlockerHandler, true);
            document.removeEventListener('keydown', this.dKeyBlockerHandler, false);
            window.removeEventListener('keydown', this.dKeyBlockerHandler, true);
            window.removeEventListener('keydown', this.dKeyBlockerHandler, false);
            this.dKeyBlockerHandler = null;
        }
    }

    fixMenuPositions() {
        const menus = document.querySelectorAll('.player__menu.with-role');
        menus.forEach(menu => {
            // Проверяем, является ли это меню владельца (ваше меню)
            const isOwnerMenu = menu.closest('.my-role') || menu.closest('.my-player');
            
            if (isOwnerMenu) return; // Пропускаем ваше меню

            // Сохраняем оригинальные стили
            if (!this.originalStyles.has(menu)) {
                this.originalStyles.set(menu, {
                    right: menu.style.right,
                    position: menu.style.position
                });
            }

            // Сбрасываем right для других игроков
            menu.style.right = '0.5rem';
        });
    }

    resetMenuPositions() {
        this.originalStyles.forEach((styles, menu) => {
            if (menu) {
                menu.style.right = styles.right;
                menu.style.position = styles.position;
            }
        });
        this.originalStyles.clear();
    }

    hideOtherRoles() {
        const allRoles = document.querySelectorAll('.player__role.role.role');
        allRoles.forEach(roleElement => {
            if (roleElement.closest('.my-role') || roleElement.closest('.my-player')) return;

            if (!this.originalRoles.has(roleElement)) {
                this.originalRoles.set(roleElement, {
                    display: roleElement.style.display,
                    visibility: roleElement.style.visibility
                });
            }

            roleElement.style.display = 'none';
        });

        // Обновляем наблюдатель
        if (!this.roleObserver) {
            this.roleObserver = new MutationObserver((mutations) => {
                if (this.isFaked) {
                    const allRoles = document.querySelectorAll('.player__role.role.role');
                    const allMenus = document.querySelectorAll('.player__menu.with-role');
                    
                    allRoles.forEach(roleElement => {
                        if (!roleElement.closest('.my-role') && !roleElement.closest('.my-player')) {
                            roleElement.style.display = 'none';
                        }
                    });

                    allMenus.forEach(menu => {
                        if (!menu.closest('.my-role') && !menu.closest('.my-player')) {
                            menu.style.right = '0.5rem';
                        }
                    });
                }
            });

            this.roleObserver.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['style', 'class']
            });
        }
    }

    resetRoles() {
        // Восстанавливаем оригинальные состояния ролей
        this.originalRoles.forEach((state, roleElement) => {
            if (roleElement) {
                roleElement.style.display = state.display;
                roleElement.style.visibility = state.visibility;
            }
        });
        
        this.originalRoles.clear();
        this.resetMenuPositions();

        if (this.roleObserver) {
            this.roleObserver.disconnect();
            this.roleObserver = null;
        }

        // Возвращаем свою роль в исходное состояние
        const myRole = document.querySelector('.player__role.role.role.my-role');
        if (myRole) {
            const useElement = myRole.querySelector('use');
            if (useElement && myRole.hasAttribute('data-original-role')) {
                const originalRole = myRole.getAttribute('data-original-role');
                const base = myRole.getAttribute('data-original-sprite-base') || this.resolveRoleSpriteBaseUrl();
                const href = `${base}#${originalRole}`;
                useElement.setAttribute('href', href);
                useElement.setAttribute('xlink:href', href);
            }

            const tooltipContent = myRole.querySelector('.tooltip .content span');
            if (tooltipContent && myRole.hasAttribute('data-original-role-name')) {
                const originalRoleName = myRole.getAttribute('data-original-role-name');
                tooltipContent.textContent = `Ваша роль - ${originalRoleName}`;
            }
        }

        // Полностью очищаем все обработчики
        this.removeAllKeyHandlers();
        // Переустанавливаем основной обработчик
        this.setupKeyHandlers();
        
        // Очищаем флаг фейка
        this.isFaked = false;
    }

    changeRole() {
        if (!this.isEnabled) return;

        const roleElement = document.querySelector('.player__role.role.role.my-role');
        
        if (!roleElement) {
            console.log('Role element not found');
            return;
        }

        // Сохраняем оригинальную роль при первой подмене
        if (!roleElement.hasAttribute('data-original-role')) {
            const originalUse = roleElement.querySelector('use');
            if (originalUse) {
                const rawHref = originalUse.getAttribute('href') || originalUse.getAttribute('xlink:href') || '';
                const parts = rawHref.split('#');
                const base = parts[0] || this.resolveRoleSpriteBaseUrl();
                const originalRole = parts[1] || 'civilian';
                roleElement.setAttribute('data-original-sprite-base', base);
                roleElement.setAttribute('data-original-role', originalRole);
            }

            const originalTooltip = roleElement.querySelector('.tooltip .content span');
            if (originalTooltip) {
                roleElement.setAttribute('data-original-role-name', originalTooltip.textContent.replace('Ваша роль - ', ''));
            }
        }

        // Переключаемся на следующую роль
        this.currentRoleIndex = (this.currentRoleIndex + 1) % this.roles.length;
        const newRole = this.roles[this.currentRoleIndex];
        console.log("Switching to role:", newRole);
        
        // Обновляем иконку роли
        const useElement = roleElement.querySelector('use');
        if (useElement) {
            const base = roleElement.getAttribute('data-original-sprite-base') || this.resolveRoleSpriteBaseUrl();
            const href = `${base}#${newRole.icon}`;
            useElement.setAttribute('href', href);
            useElement.setAttribute('xlink:href', href);
            console.log("Updated role icon");
        }

        // Обновляем текст роли
        const tooltipContent = roleElement.querySelector('.tooltip .content span');
        if (tooltipContent) {
            tooltipContent.textContent = `Ваша роль - ${newRole.name}`;
            console.log("Updated role text");
        }
    }
}

// Создаем экземпляр только если его еще нет
if (!window.roleFaker) {
    console.log("Creating new RoleFaker instance");
    window.roleFaker = new RoleFaker();
} 
