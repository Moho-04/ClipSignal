# ClipSignal
Scans public posts for freelance buying-intent, scores with Gemini, publishes to Discord.
Runs on GitHub Actions cron (*/15). Stack: Neon Postgres + Gemini Flash free tiers.
Setup: add secrets DATABASE_URL, GEMINI_API_KEY, PAID_DISCORD_WEBHOOK_URL, FREE_DISCORD_WEBHOOK_URL.
