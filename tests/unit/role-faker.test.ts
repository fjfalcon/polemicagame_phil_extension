// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";

const seam = vi.hoisted(() => ({ domSubs: [] as Array<() => void> }));
vi.mock("@core/dom", () => ({
  onDomChange: vi.fn((cb: () => void) => {
    seam.domSubs.push(cb);
    return () => {
      seam.domSubs = seam.domSubs.filter((s) => s !== cb);
    };
  }),
  safeClick: vi.fn(),
  isVisible: () => true,
}));
vi.mock("@core/toast", () => ({ showToast: vi.fn(), clearToasts: vi.fn() }));
const keys = vi.hoisted(() => ({ map: new Map<string, () => void>() }));
vi.mock("@core/keyboard", async (orig) => ({
  ...((await orig()) as object),
  keyboard: {
    register: vi.fn((code: string, fn: () => void) => {
      keys.map.set(code, fn);
      return () => keys.map.delete(code);
    }),
  },
}));
vi.mock("@core/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { isRoleFaked, roleFakerFeature, shouldSwallowRoleKey } from "@content/features/role-faker";
import type { FeatureContext } from "@core/feature";

function keydown(init: KeyboardEventInit & { code: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("shouldSwallowRoleKey (§4.5 gates of the D blocker)", () => {
  test("swallows the configured hide key", () => {
    expect(shouldSwallowRoleKey(keydown({ code: "KeyD" }), "KeyD")).toBe(true);
  });

  test("matches by physical key, not by layout (KeyD is «в» in Russian)", () => {
    expect(shouldSwallowRoleKey(keydown({ code: "KeyD", key: "в" }), "KeyD")).toBe(true);
    expect(shouldSwallowRoleKey(keydown({ code: "KeyV", key: "d" }), "KeyD")).toBe(false);
  });

  test("keeps swallowing an auto-repeating key", () => {
    // Инвертированный гейт §4.5: пропустив повтор, мы отдали бы D сайту, и он
    // показал бы настоящую роль посреди подмены. Тест держит это решение.
    expect(shouldSwallowRoleKey(keydown({ code: "KeyD", repeat: true }), "KeyD")).toBe(true);
  });

  test.each(["KeyF", "KeyE", "Space"])("ignores unrelated key %s", (code) => {
    expect(shouldSwallowRoleKey(keydown({ code }), "KeyD")).toBe(false);
  });

  test("follows the rebound hide key, not the literal D", () => {
    expect(shouldSwallowRoleKey(keydown({ code: "KeyD" }), "KeyG")).toBe(false);
    expect(shouldSwallowRoleKey(keydown({ code: "KeyG" }), "KeyG")).toBe(true);
  });

  test.each([
    ["ctrlKey", { ctrlKey: true }],
    ["metaKey", { metaKey: true }],
    ["altKey", { altKey: true }],
  ])("does not swallow a %s combination", (_name, modifier) => {
    expect(shouldSwallowRoleKey(keydown({ code: "KeyD", ...modifier }), "KeyD")).toBe(false);
  });

  test("does not swallow while the user is typing (KeyD is «в» in Russian)", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const event = keydown({ code: "KeyD" });
    input.dispatchEvent(event);
    expect(shouldSwallowRoleKey(event, "KeyD")).toBe(false);
  });
});

describe("подмена переживает Vue-перерисовки (аудит скрытия ролей 29.08.2026, №3/№8)", () => {
  function mountTable(): { own: HTMLElement; foe: HTMLElement } {
    document.body.innerHTML = `
      <div class="players">
        <div class="player my-player">
          <div class="my-role">
            <div class="player__role role my-role-el"></div>
          </div>
        </div>
        <div class="player" id="p2"></div>
      </div>`;
    // Своя роль: настоящий селектор .player__role.role.role.my-role.
    const ownWrap = document.querySelector(".my-role") as HTMLElement;
    ownWrap.innerHTML = "";
    const own = document.createElement("div");
    own.className = "player__role role my-role";
    own.innerHTML = `<svg><use href="/sprite.svg#sheriff"></use></svg>
      <div class="tooltip"><div class="content"><span>Ваша роль - Шериф</span></div></div>`;
    ownWrap.appendChild(own);
    const foe = document.createElement("div");
    foe.className = "player__role role";
    (document.querySelector("#p2") as HTMLElement).appendChild(foe);
    return { own, foe };
  }

  function enable(): void {
    roleFakerFeature.enable({
      settings: { enable_role_faker: true, hotkey_role_hide: "KeyD" },
    } as unknown as FeatureContext);
  }
  const pressF = () => keys.map.get("KeyF")!();
  const pressE = () => keys.map.get("KeyE")!();
  const fireDom = () => seam.domSubs.forEach((cb) => cb());

  afterEach(() => {
    roleFakerFeature.disable();
    seam.domSubs = [];
    keys.map.clear();
  });

  test("№3: пересозданный узел СВОЕЙ роли получает ту же подмену заново", () => {
    const { own } = mountTable();
    enable();
    pressF();
    expect(isRoleFaked()).toBe(true);
    const fakedHref = own.querySelector("use")!.getAttribute("href")!;
    expect(fakedHref, "подмена наложена").not.toContain("#sheriff");
    // Vue пересоздал узел: настоящая роль вернулась на экран.
    const fresh = document.createElement("div");
    fresh.className = own.className; // Vue создаёт узел заново: наших data-* нет
    fresh.innerHTML = `<svg><use href="/sprite.svg#sheriff"></use></svg>
      <div class="tooltip"><div class="content"><span>Ваша роль - Шериф</span></div></div>`;
    own.replaceWith(fresh);
    fireDom();
    expect(
      fresh.querySelector("use")!.getAttribute("href"),
      "та же фальшивая роль перенанесена, без сдвига по кругу",
    ).toBe(fakedHref);
    expect(isRoleFaked()).toBe(true);
  });

  test("№8: чужой узел, созданный ВО ВРЕМЯ подмены, скрыт и возвращается по E", () => {
    mountTable();
    enable();
    pressF();
    // Vue создал новый узел роли напарника уже после F.
    const late = document.createElement("div");
    late.className = "player__role role";
    late.style.display = "inline-flex";
    (document.querySelector("#p2") as HTMLElement).appendChild(late);
    fireDom();
    expect(late.style.display, "скрыт наблюдателем").toBe("none");
    pressE();
    expect(late.style.display, "E вернул исходный display, а не бросил скрытым").toBe(
      "inline-flex",
    );
    expect(isRoleFaked()).toBe(false);
  });
});
