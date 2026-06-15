import requests
from bs4 import BeautifulSoup
import json
import re

def parse_match(match_id):
    url = f"https://polemicagame.com/match/{match_id}"
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
    
    try:
        response = requests.get(url, headers=headers)
        if response.status_code == 200:
            # Updated regex pattern to match the exact format
            pattern = r':game-data=\'(.*?)\'\s+:user='
            game_data_match = re.search(pattern, response.text, re.DOTALL)
            
            if game_data_match:
                game_data = json.loads(game_data_match.group(1))
                
                # Save parsed JSON
                with open(f'match_{match_id}.json', 'w', encoding='utf-8') as f:
                    json.dump(game_data, f, ensure_ascii=False, indent=2)
                
                print(f"Match {match_id} data saved successfully!")
                return game_data
            else:
                print("Game data not found in HTML")
                print("Raw response text preview:")
                print(response.text[:200])
                return None
        else:
            print(f"Error: {response.status_code}")
            return None
    except Exception as e:
        print(f"Error: {e}")
        return None

# Usage
match_id = 314446
match_data = parse_match(match_id)


