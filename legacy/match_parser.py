import requests
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
            pattern = r':game-data=\'(.*?)\'\s+:user='
            game_data_match = re.search(pattern, response.text, re.DOTALL)

            if game_data_match:
                game_data = json.loads(game_data_match.group(1))

                # Check if players have mmr_diff and filter them
                players_with_mmr = [player for player in game_data['players'] if 'mmr_diff' in player]
                if not players_with_mmr:
                    print(f"Match {match_id} skipped: No players with mmr_diff.")
                    return None

                return game_data
            else:
                print(f"Game data not found for match {match_id}")
                return None
        else:
            print(f"Error {response.status_code} for match {match_id}")
            return None
    except Exception as e:
        print(f"Error: {e} for match {match_id}")
        return None

def calculate_vote_percentage(match_id, player_id):
    match_data = parse_match(match_id)
    if not match_data:
        return

    # Find the target player
    target_player = next((player for player in match_data['players'] if player['id'] == player_id), None)
    if not target_player:
        print(f"Player {player_id} not found in match {match_id}.")
        return

    # Check if the player is мирный or шериф
    if target_player['role'] not in ['мирный', 'шериф']:
        print(f"Player {player_id} is not мирный or шериф in match {match_id}.")
        return

    # Calculate voting statistics for day 2
    votes_in_day_2 = 0
    total_votes = 0

    for player in match_data['players']:
        for vote in player.get('votes', []):
            if vote['day'] == 2:
                total_votes += 1
                if vote['targetId'] == player_id and vote['targetRole'] == 'мирный':
                    votes_in_day_2 += 1

    if total_votes > 0:
        percentage = (votes_in_day_2 / total_votes) * 100
        print(f"Player {player_id} was voted as мирный on day 2 in {percentage:.2f}% of cases in match {match_id}.")
    else:
        print(f"No votes found on day 2 in match {match_id}.")

def process_matches(start_match_id, end_match_id, player_id):
    for match_id in range(start_match_id, end_match_id + 1):
        try:
            calculate_vote_percentage(match_id, player_id)
        except Exception as e:
            print(f"An error occurred while processing match {match_id}: {e}")

# Usage
start_match_id = 256048
end_match_id = 350000
player_id = 4992  # Replace with the actual player ID
process_matches(start_match_id, end_match_id, player_id)
