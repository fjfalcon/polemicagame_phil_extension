/**
 * Кастомные модальные окна (тёмная тема).
 *
 * ФИКС прежнего бага: НЕ переопределяем нативный window.confirm (он синхронный,
 * а подмена была async — ломала любой код вида `if (confirm(...))`).
 * Вместо этого предоставляем явный async confirmModal()/showModal() для нашего кода.
 */
import { escapeHtml } from "./escape";

export interface ModalButton {
  label: string;
  value?: unknown;
  variant?: "primary" | "default" | "danger";
}

export interface ModalOptions {
  title?: string;
  message: string;
  /** Разрешить HTML в message (по умолчанию текст экранируется). */
  allowHtml?: boolean;
  buttons?: ModalButton[];
}

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "polemica-modal-styles";
  style.textContent = `
    .pm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;
      align-items:center;justify-content:center;z-index:2147483600;animation:pmFade .15s ease}
    .pm-modal{background:#1e1f26;color:#fff;min-width:280px;max-width:90vw;border-radius:12px;
      box-shadow:0 20px 60px rgba(0,0,0,.5);padding:20px;font:14px/1.5 system-ui,sans-serif}
    .pm-title{font-weight:700;font-size:16px;margin-bottom:10px}
    .pm-msg{margin-bottom:18px;color:rgba(255,255,255,.85)}
    .pm-actions{display:flex;gap:8px;justify-content:flex-end}
    .pm-btn{border:none;border-radius:8px;padding:8px 14px;cursor:pointer;font:inherit;
      background:rgba(255,255,255,.1);color:#fff}
    .pm-btn.primary{background:#3b82f6}
    .pm-btn.danger{background:#ef4444}
    @keyframes pmFade{from{opacity:0}to{opacity:1}}
  `;
  document.head.appendChild(style);
}

export function showModal<T = unknown>(options: ModalOptions): Promise<T | undefined> {
  injectStyles();
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "pm-overlay";
    const modal = document.createElement("div");
    modal.className = "pm-modal";

    if (options.title) {
      const t = document.createElement("div");
      t.className = "pm-title";
      t.textContent = options.title;
      modal.appendChild(t);
    }
    const msg = document.createElement("div");
    msg.className = "pm-msg";
    if (options.allowHtml) msg.innerHTML = options.message;
    else msg.textContent = options.message;
    modal.appendChild(msg);

    const actions = document.createElement("div");
    actions.className = "pm-actions";
    const buttons = options.buttons ?? [{ label: "OK", value: true, variant: "primary" }];
    const close = (value: unknown) => {
      overlay.remove();
      resolve(value as T);
    };
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.className = `pm-btn ${b.variant ?? "default"}`;
      btn.textContent = b.label;
      btn.addEventListener("click", () => close(b.value));
      actions.appendChild(btn);
    }
    modal.appendChild(actions);
    overlay.appendChild(modal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(undefined);
    });
    document.body.appendChild(overlay);
  });
}

/** Явная async-замена confirm() для нашего кода (НЕ трогает нативный confirm). */
export function confirmModal(message: string, title?: string): Promise<boolean> {
  return showModal<boolean>({
    title,
    message,
    buttons: [
      { label: "Отмена", value: false },
      { label: "OK", value: true, variant: "primary" },
    ],
  }).then((v) => v === true);
}

export { escapeHtml };
