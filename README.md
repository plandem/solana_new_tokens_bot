

# steps
- install `docker`, `docker-compose`, `git`
- git pull `https://github.com/plandem/solana_new_tokens_bot.git`
- navigate to folder `solana_new_tokens_bot`
- copy `.env.example` to `.env` and update with relevant values (to get id of telegram chat, interact with `@username_to_id_bot` in telegram)
- `docker compose build`
- `docker compose up`
