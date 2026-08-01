import { describe, expect, test } from "vitest";
import { escapeHtml } from "@core/escape";

describe("escapeHtml", () => {
  test("escapes all HTML-significant characters without double escaping", () => {
    expect(escapeHtml(`<a title="x's">&</a>`)).toBe(
      "&lt;a title=&quot;x&#39;s&quot;&gt;&amp;&lt;/a&gt;",
    );
  });
});
