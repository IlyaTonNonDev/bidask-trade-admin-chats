# TON Buy Bot

Telegram bot for monitoring TON token trades on Bidask, STON.fi, and DeDust with moderation features.

## Features

- **Buy/Sell Notifications**: Monitors BidAsk, STON.fi, and DeDust pools and sends notifications above threshold
- **DEX Links**: Quick trade links in notifications (BidAsk, DTRADE, Graph)
- **CA Info**: Shows contract address with swap links
- **Moderation**: Mute/unmute users in group chats (admin only)

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Activate bot and show token info |
| `/settoken <CA>` | Set token contract address |
| `/setpool <address>` | Set BidAsk pool address |
| `/CA` | Show contract address |
| `/status` | Check bot status |
| `/volume [amount]` | Show/change minimum buy threshold |
| `/help` | Show help |
| `/mute 30m` | Mute user for 30 minutes (reply to message) |
| `/unmute` | Unmute user (reply to message) |

## Setup

1. Clone this repository
2. Copy `secretkeys.env.example` to `secretkeys.env`
3. Fill in your tokens in `secretkeys.env`:
   - `TELEGRAM_BOT_TOKEN` - Get from [@BotFather](https://t.me/BotFather)
   - `TON_API_KEY` - Get from [TON Console](https://tonconsole.com)
4. Install dependencies: `npm install`
5. Run: `npm start`

## Docker (recommended for VPS)

1. Ensure `secretkeys.env` exists in the project root.
2. Ensure `bot_state.json` exists (can be empty `{}` on first run).
3. Build and run:
   - `docker compose up -d --build`
4. View logs:
   - `docker logs -f ton-buybot`

## Configuration

Use bot commands to configure each chat:

- `/settoken <CA>` to set the token
- `/setpool <address>` to set the BidAsk pool
- `/volume [amount]` to set the minimum TON threshold

If you still prefer hardcoded defaults, edit values in `bot.js`:

```javascript
const TOKEN_ADDRESS = 'your_token_address';
const BIDASK_POOL_ADDRESS = 'your_pool_address';
let MIN_BUY_THRESHOLD = 5; // Minimum TON for notification
const POLL_INTERVAL = 10000; // Check interval in ms
```

## Hosting

Works with:
- bothost.ru
- Replit
- Any Node.js hosting with environment variables support
- Any VPS with Docker (use `docker-compose.yml`)

## License

MIT
