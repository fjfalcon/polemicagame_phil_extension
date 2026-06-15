console.log('Match Parser loaded!');

async function parseMatch(matchId) {
    console.log('Starting to parse match:', matchId);
    const url = `https://polemicagame.com/match/${matchId}`;
    
    try {
        const response = await fetch(url);
        console.log('Response status:', response.status);
        
        if (response.status === 200) {
            const text = await response.text();
            console.log('Response text preview:', text.substring(0, 200));
            
            // Look for game data in Vue.js data attribute
            const gameDataMatch = text.match(/data-game='([^']+)'/);
            // Alternative patterns if the above doesn't match
            const altMatch = gameDataMatch || 
                           text.match(/:game='([^']+)'/) || 
                           text.match(/game-data='([^']+)'/);
            
            if (altMatch) {
                console.log('Found game data, parsing...');
                const gameData = JSON.parse(altMatch[1]);
                console.log('Game data parsed:', gameData);
                
                // Dispatch event with game data
                const event = new CustomEvent('gameDataParsed', { 
                    detail: {
                        ...gameData,
                        players: gameData.players || [],
                        history: gameData.history || gameData.events || []
                    }
                });
                document.dispatchEvent(event);
                
                return gameData;
            } else {
                console.log("Game data not found in HTML");
                return null;
            }
        }
    } catch (error) {
        console.error('Error:', error);
        return null;
    }
}

// Автоматически запускаем парсинг при загрузке страницы матча
if (window.location.pathname.includes('/match/')) {
    console.log('Match page detected!');
    const matchId = window.location.pathname.split('/').pop();
    parseMatch(matchId);
}

window.parseMatch = parseMatch;