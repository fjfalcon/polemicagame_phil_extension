class ModalEnhancer {
    constructor() {
        this.initStyles();
        this.initModalContainer();
        this.interceptAlerts();
    }

    initStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .enhanced-modal-overlay {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(13, 17, 23, 0.8);
                backdrop-filter: blur(10px);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 9999;
                opacity: 0;
                transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
            }

            .enhanced-modal {
                background: linear-gradient(145deg, rgba(28, 30, 44, 0.95), rgba(20, 22, 36, 0.95));
                border-radius: 20px;
                padding: 28px;
                max-width: 440px;
                width: 90%;
                transform: translateY(20px) scale(0.95);
                transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
                border: 1px solid rgba(255, 255, 255, 0.1);
                box-shadow: 
                    0 4px 24px rgba(0, 0, 0, 0.4),
                    inset 0 0 40px rgba(255, 255, 255, 0.03);
                position: relative;
                overflow: hidden;
            }

            .enhanced-modal::before {
                content: '';
                position: absolute;
                top: 0;
                left: -50%;
                width: 200%;
                height: 1px;
                background: linear-gradient(
                    90deg,
                    transparent,
                    rgba(255, 255, 255, 0.2),
                    transparent
                );
            }

            .enhanced-modal.show {
                transform: translateY(0) scale(1);
            }

            .enhanced-modal-overlay.show {
                opacity: 1;
            }

            .enhanced-modal-title {
                color: #fff;
                font-size: 24px;
                font-weight: 600;
                margin-bottom: 20px;
                display: flex;
                align-items: center;
                gap: 12px;
                text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
            }

            .enhanced-modal-content {
                color: rgba(255, 255, 255, 0.9);
                font-size: 16px;
                line-height: 1.6;
                margin-bottom: 28px;
                padding: 16px;
                background: rgba(255, 255, 255, 0.03);
                border-radius: 12px;
                border: 1px solid rgba(255, 255, 255, 0.05);
            }

            .enhanced-modal-buttons {
                display: flex;
                gap: 16px;
                justify-content: flex-end;
            }

            .enhanced-modal-button {
                padding: 10px 24px;
                border-radius: 12px;
                font-size: 15px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
                border: none;
                position: relative;
                overflow: hidden;
                background: linear-gradient(145deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.05));
                color: white;
                text-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
            }

            .enhanced-modal-button::before {
                content: '';
                position: absolute;
                top: 0;
                left: -100%;
                width: 100%;
                height: 100%;
                background: linear-gradient(
                    90deg,
                    transparent,
                    rgba(255, 255, 255, 0.2),
                    transparent
                );
                transition: 0.5s;
            }

            .enhanced-modal-button:hover::before {
                left: 100%;
            }

            .enhanced-modal-button.primary {
                background: linear-gradient(145deg, #4CAF50, #43A047);
                box-shadow: 0 4px 15px rgba(76, 175, 80, 0.3);
            }

            .enhanced-modal-button.primary:hover {
                transform: translateY(-2px);
                box-shadow: 0 6px 20px rgba(76, 175, 80, 0.4);
            }

            .enhanced-modal-button.secondary {
                background: linear-gradient(145deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.05));
                box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
            }

            .enhanced-modal-button.secondary:hover {
                transform: translateY(-2px);
                box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3);
            }

            .enhanced-modal-button.danger {
                background: linear-gradient(145deg, #f44336, #e53935);
                box-shadow: 0 4px 15px rgba(244, 67, 54, 0.3);
            }

            .enhanced-modal-button.danger:hover {
                transform: translateY(-2px);
                box-shadow: 0 6px 20px rgba(244, 67, 54, 0.4);
            }

            .enhanced-modal-icon {
                font-size: 32px;
                filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3));
                animation: iconFloat 2s ease-in-out infinite;
            }

            @keyframes iconFloat {
                0%, 100% { transform: translateY(0); }
                50% { transform: translateY(-5px); }
            }

            .enhanced-modal-overlay .enhanced-modal {
                animation: modalPulse 2s cubic-bezier(0.16, 1, 0.3, 1) infinite;
            }

            @keyframes modalPulse {
                0% { box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4), inset 0 0 40px rgba(255, 255, 255, 0.03); }
                50% { box-shadow: 0 4px 30px rgba(0, 0, 0, 0.5), inset 0 0 50px rgba(255, 255, 255, 0.05); }
                100% { box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4), inset 0 0 40px rgba(255, 255, 255, 0.03); }
            }
        `;
        document.head.appendChild(style);
    }

    initModalContainer() {
        this.modalContainer = document.createElement('div');
        document.body.appendChild(this.modalContainer);
    }

    showModal(options) {
        const overlay = document.createElement('div');
        overlay.className = 'enhanced-modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'enhanced-modal';

        const title = document.createElement('div');
        title.className = 'enhanced-modal-title';
        
        // Добавляем иконку в зависимости от типа
        const icon = document.createElement('span');
        icon.className = 'enhanced-modal-icon';
        switch(options.type) {
            case 'tech':
                icon.textContent = '⚠️';
                break;
            case 'stop':
                icon.textContent = '🛑';
                break;
            case 'delete':
                icon.textContent = '🗑️';
                break;
            default:
                icon.textContent = 'ℹ️';
        }
        title.appendChild(icon);
        title.appendChild(document.createTextNode(options.title));

        const content = document.createElement('div');
        content.className = 'enhanced-modal-content';
        content.textContent = options.message;

        const buttons = document.createElement('div');
        buttons.className = 'enhanced-modal-buttons';

        if (options.buttons) {
            options.buttons.forEach(btn => {
                const button = document.createElement('button');
                button.className = `enhanced-modal-button ${btn.type || 'secondary'}`;
                button.textContent = btn.text;
                button.onclick = () => {
                    this.closeModal(overlay);
                    btn.onClick?.();
                };
                buttons.appendChild(button);
            });
        }

        modal.appendChild(title);
        modal.appendChild(content);
        modal.appendChild(buttons);
        overlay.appendChild(modal);

        this.modalContainer.appendChild(overlay);
        
        // Анимация появления
        requestAnimationFrame(() => {
            overlay.classList.add('show');
            modal.classList.add('show');
        });
    }

    closeModal(overlay) {
        overlay.classList.remove('show');
        setTimeout(() => overlay.remove(), 300);
    }

    interceptAlerts() {
        // Перехватываем стандартные алерты и заменяем на наши модальные окна
        const originalConfirm = window.confirm;
        window.confirm = (message) => {
            return new Promise((resolve) => {
                this.showModal({
                    title: 'Подтверждение',
                    message: message,
                    buttons: [
                        {
                            text: 'Отмена',
                            type: 'secondary',
                            onClick: () => resolve(false)
                        },
                        {
                            text: 'Подтвердить',
                            type: 'primary',
                            onClick: () => resolve(true)
                        }
                    ]
                });
            });
        };
    }
}

// Инициализация
const modalEnhancer = new ModalEnhancer();

// Пример использования для разных типов модальных окон
function showTechModal() {
    modalEnhancer.showModal({
        type: 'tech',
        title: 'Технический фол',
        message: 'Вы уверены, что хотите выдать технический фол?',
        buttons: [
            {
                text: 'Отмена',
                type: 'secondary'
            },
            {
                text: 'Выдать',
                type: 'danger'
            }
        ]
    });
}

function showStopModal() {
    modalEnhancer.showModal({
        type: 'stop',
        title: 'Остановка игры',
        message: 'Вы действительно хотите остановить игру?',
        buttons: [
            {
                text: 'Отмена',
                type: 'secondary'
            },
            {
                text: 'Остановить',
                type: 'danger'
            }
        ]
    });
} 