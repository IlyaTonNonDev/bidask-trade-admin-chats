const TelegramBot = require('node-telegram-bot-api');

// ---------------- CONFIG ----------------
const TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const BIDASK_POOL_ADDRESS = process.env.BIDASK_POOL_ADDRESS;
const MIN_VOLUME_DEFAULT = 20;

let minVolume = MIN_VOLUME_DEFAULT;
let isMuted = false;

const bot = new TelegramBot(TOKEN, { polling: true });

console.log("Bot started.");

// ---------------- HELP TEXT --------------
function helpText() {
  return (
    "🤖 *Bidask Tracker Bot*\n\n" +
    "Команды:\n" +
    "/start — включить уведомления в этот чат\n" +
    "/help — помощь\n" +
    `/setthreshold X — изменить минимальный объём (сейчас ${minVolume})\n` +
    `/mute — выключить уведомления\n` +
    `/unmute — включить уведомления\n`
  );
}

// ---------------- START ------------------
bot.onText(/\/start/, (msg) => {
  if (msg.chat.id != ADMIN_CHAT_ID) return;

  bot.sendMessage(msg.chat.id, "🔔 Бот активирован. Уведомления будут приходить сюда.");
});

// ---------------- HELP -------------------
bot.onText(/\/help/, (msg) => {
  if (msg.chat.id != ADMIN_CHAT_ID) return;
  bot.sendMessage(msg.chat.id, helpText(), { parse_mode: "Markdown" });
});

// ----------- SET THRESHOLD ---------------
bot.onText(/\/setthreshold (.+)/, (msg, match) => {
  if (msg.chat.id != ADMIN_CHAT_ID) return;

  const value = parseFloat(match[1]);
  if (isNaN(value) || value <= 0) {
    return bot.sendMessage(msg.chat.id, "❌ Укажите число > 0");
  }

  minVolume = value;
  bot.sendMessage(msg.chat.id, `🔧 Новый минимальный объём: *${minVolume} TON*`, { parse_mode: "Markdown" });
});

// ---------------- MUTE -------------------
bot.onText(/\/mute/, (msg) => {
  if (msg.chat.id != ADMIN_CHAT_ID) return;

  isMuted = true;
  bot.sendMessage(msg.chat.id, "🔕 Уведомления отключены.");
});

// ---------------- UNMUTE -----------------
bot.onText(/\/unmute/, (msg) => {
  if (msg.chat.id != ADMIN_CHAT_ID) return;

  isMuted = false;
  bot.sendMessage(msg.chat.id, "🔔 Уведомления включены.");
});

// =======================================================
//                    PARSE TRANSACTION
// =======================================================

function parseTransaction(tx, minThreshold) {
  try {
    if (!tx.in_msg) return null;

    const op = tx.in_msg.decoded_op_name;
    const body = tx.in_msg.decoded_body;

    if (op !== "bidask_damm_swap" || !body) return null;

    // True TON volume
    const tonVolume = Number(body.native_amount || 0) / 1e9;
    if (tonVolume < minThreshold) return null;

    // Detect BUY / SELL correctly
    const tonIn = Number(body.ton_in || 0);
    const jettonIn = Number(body.jetton_in || 0);

    let type = null;
    if (tonIn > 0 && jettonIn === 0) type = "BUY";     // TON → token
    else if (jettonIn > 0 && tonIn === 0) type = "SELL"; // token → TON
    else return null;

    return {
      type,
      volume: tonVolume,
      hash: tx.hash,
    };

  } catch (err) {
    console.error("parseTransaction error:", err);
    return null;
  }
}

// =======================================================
//                    FETCH TRANSACTIONS
// =======================================================

async function fetchTransactions() {
  const url = `https://tonapi.io/v2/blockchain/accounts/${BIDASK_POOL_ADDRESS}/transactions?limit=40`;

  const res = await fetch(url);
  const data = await res.json();

  return data.transactions || [];
}

let lastProcessedHash = null;

// =======================================================
//                CHECK & SEND ALERTS
// =======================================================

async function monitorTransactions() {
  try {
    const transactions = await fetchTransactions();
    if (!Array.isArray(transactions)) return;

    for (const tx of transactions) {
      if (tx.hash === lastProcessedHash) break;

      const parsed = parseTransaction(tx, minVolume);
      if (!parsed) continue;

      if (!isMuted) {
        const emoji = parsed.type === "BUY" ? "🚀" : "❤️";

        const text =
          `${emoji} *NEW ${parsed.type}*\n` +
          `💰 Объём: *${parsed.volume} TON*\n` +
          `🔗 TX: https://tonviewer.com/transaction/${parsed.hash}`;

        bot.sendMessage(ADMIN_CHAT_ID, text, { parse_mode: "Markdown" });
      }
    }

    if (transactions.length > 0) {
      lastProcessedHash = transactions[0].hash;
    }

  } catch (err) {
    console.error("monitorTransactions error:", err);
  }
}

// Run every 7 seconds
setInterval(monitorTransactions, 7000);
