console.log("Content script loaded");

// Добавляем слушатель для кнопки поиска
document.addEventListener('click', (e) => {
  console.log("Click detected", e.target); // Для отладки
  
  // Проверяем кнопку поиска
  if (e.target.classList.contains('p-play__profile-button')) {
    console.log("Found search button:", e.target); // Для отладки
    
    // Получаем количество игроков из DOM
    let playersCount = '0';
    const playersElement = document.querySelector('.p-play__profile-game-search-players');
    if (playersElement) {
      const matches = playersElement.textContent.match(/\d+/g);
      if (matches) {
        playersCount = matches[0];
      }
    }
    console.log("Players count:", playersCount); // Для отладки

    // Отправляем сообщение в background script
    chrome.runtime.sendMessage({
      action: "startSearch",
      players: playersCount,
      gameFound: true
    }, response => {
      console.log("Message sent, response:", response); // Для отладки
    });
  }
  
  // Проверяем кнопку закрытия поиска
  if (e.target.classList.contains('p-play__profile-game-search-close')) {
    console.log("Stop search clicked"); // Для отладки
    chrome.runtime.sendMessage({
      action: "stopSearch"
    }, response => {
      console.log("Stop message sent, response:", response); // Для отладки
    });
  }
});

// Начинаем наблюдение за DOM без вызова неопределенных функций
const observer = new MutationObserver(() => {
    // Просто наблюдаем за изменениями DOM без выполнения каких-либо действий
});

observer.observe(document.body, {
    childList: true,
    subtree: true
});
