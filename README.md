# TON Buy Bot

Telegram bot for monitoring TON token purchases on BidAsk DEX with moderation features.

## Features

- **Buy Notifications**: Monitors BidAsk pool and sends notifications for purchases above threshold
- **CA Info**: Shows contract address with swap links
- **Moderation**: Mute/unmute users in group chats (admin only)

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Activate bot and show CA |
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

## Configuration

Edit these values in `bot.js`:

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

## License

MIT
