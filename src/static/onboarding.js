// Онбординг: единственная логика — закрыть вкладку. Файл отдельный, потому
// что CSP страниц расширения (MV3) запрещает инлайн-скрипты.
document.getElementById("done")?.addEventListener("click", () => window.close());
