// Telegram Bot: CA info + Модерация (mute/unmute) + Мониторинг покупок и продаж
const TelegramBot = require('node-telegram-bot-api');
const fetch = global.fetch; // В Node 18+ fetch встроен

// ==================== КОНФИГУРАЦИЯ ====================
const TOKEN_ADDRESS = 'EQDKMh511DOn02mL0nf0JrND0TlkUKmos17eK9zKyGAsjS1K';
const BIDASK_POOL_ADDRESS = '0:ece84060d087c39351665aacb8bc176f603248338af66e4f4ff13529bb594686';
const TOTAL_SUPPLY = 1023257;
const POLL_INTERVAL = 10000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TON_API_KEY = process.env.TON_API_KEY;

if (!TELEGRAM_BOT_TOKEN) {
  console.error('Error: TELEGRAM_BOT_TOKEN is not set');
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// ==================== ХРАНЕНИЕ НАСТРОЕК ====================
const chatSettings = {}; // { chatId: { minBuyThreshold: 5 } }
const notificationChats = new Set();

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================
function crc16(data) {
  const poly = 0x1021;
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ poly) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function hexToNonBounceable(hexAddress) {
  try {
    let workchain = 0, hash = hexAddress.includes(':') ? hexAddress.split(':')[1] : hexAddress;
    if (hexAddress.includes(':')) workchain = parseInt(hexAddress.split(':')[0]);
    hash = hash.replace(/^0x/, '');
    const hashBytes = Buffer.from(hash, 'hex');
    if (hashBytes.length !== 32) return hexAddress;
    const data = Buffer.alloc(34);
    data[0] = 0x51;
    data[1] = workchain === -1 ? 0xff : workchain;
    hashBytes.copy(data, 2);
    const crc = crc16(data);
    const fullData = Buffer.alloc(36);
    data.copy(fullData);
    fullData[34] = (crc >> 8) & 0xff;
    fullData[35] = crc & 0xff;
    return fullData.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch (error) { return hexAddress; }
}

async function getAccountInfo(address) {
  try {
    if (!TON_API_KEY) return null;
    const response = await fetch(`https://tonapi.io/v2/accounts/${address}`, {
      headers: { 'Authorization': `Bearer ${TON_API_KEY}`, 'Content-Type': 'application/json' }
    });
    if (!response.ok) return null;
    const data = await response.json();
    return { name: data.name || null, address: data.address || address };
  } catch { return null; }
}

async function formatAddress(hexAddress) {
  const accountInfo = await getAccountInfo(hexAddress);
  if (accountInfo && accountInfo.name) return { display: accountInfo.name, link: hexAddress };
  return { display: hexToNonBounceable(hexAddress), link: hexAddress };
}

function getRocketString(volume) {
  const count = Math.min(10, Math.max(1, Math.floor(volume / 5)));
  return '🚀'.repeat(count);
}

function getHeartString(volume) {
  const count = Math.min(10, Math.max(1, Math.floor(volume / 5)));
  return '💖'.repeat(count);
}

function formatNumber(num) { return new Intl.NumberFormat('en-US').format(num); }

function calculateMC(price) {
  if (!price) return '???';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(price * TOTAL_SUPPLY);
}

// ==================== TON API ====================
async function getTransactions() {
  try {
    if (!TON_API_KEY) return [];
    const resp = await fetch(`https://tonapi.io/v2/blockchain/accounts/${BIDASK_POOL_ADDRESS}/transactions?limit=20`, {
      headers: { 'Authorization': `Bearer ${TON_API_KEY}`, 'Content-Type': 'application/json' }
    });
    if (!resp.ok) throw new Error(`TON API error: ${resp.status}`);
    const data = await resp.json();
    return data.transactions || [];
  } catch (error) { console.error('Error fetching transactions:', error.message); return []; }
}

async function getTokenPrice() {
  try {
    if (!TON_API_KEY) return null;
    const response = await fetch(`https://tonapi.io/v2/rates?tokens=${TOKEN_ADDRESS}&currencies=usd`, {
      headers: { 'Authorization': `Bearer ${TON_API_KEY}`, 'Content-Type': 'application/json' }
    });
    if (!response.ok) throw new Error(`Rates API error: ${response.status}`);
    const data = await response.json();
    return data.rates?.[TOKEN_ADDRESS]?.prices?.USD || null;
  } catch (error) { console.error('Error fetching price:', error.message); return null; }
}

let cachedTokenImage = null;
async function getTokenImage() {
  if (cachedTokenImage) return cachedTokenImage;
  if (!TON_API_KEY) return null;
  try {
    const resp = await fetch(`https://tonapi.io/v2/jettons/${TOKEN_ADDRESS}`, {
      headers: { 'Authorization': `Bearer ${TON_API_KEY}`, 'Content-Type': 'application/json' }
    });
    if (!resp.ok) throw new Error(`Jetton API error: ${resp.status}`);
    const data = await resp.json();
    const imageUrl = data.metadata?.image || data.preview || null;
    if (imageUrl) cachedTokenImage = imageUrl;
    return imageUrl;
  } catch (error) { console.error('Error fetching token logo:', error.message); return null; }
}

// ==================== ПАРСИНГ ТРАНЗАКЦИЙ ====================
function parseTransaction(tx, minThreshold, tokenPrice) {
  try {
    console.log('Parsing transaction:', tx.hash);

    if (!tx.in_msg) return null;
    const opName = tx.in_msg.decoded_op_name;
    const decodedBody = tx.in_msg.decoded_body;
    if (opName !== 'bidask_damm_swap' || !decodedBody) return null;

    let value, type;

    if (decodedBody.native_amount) { 
      value = parseInt(decodedBody.native_amount) / 1e9;
      type = 'BUY';
      if (value < minThreshold) return null;
      console.log('BUY detected:', value);
    } else if (decodedBody.jetton === TOKEN_ADDRESS) { 
      const tonReceived = (parseInt(decodedBody.amount) / 1e9) * tokenPrice;
      value = parseInt(decodedBody.amount) / 1e9;
      type = 'SELL';
      console.log('SELL detected:', value, 'TON equivalent:', tonReceived);
      if (tonReceived < minThreshold) return null;
    } else return null;

    const from = decodedBody.from_address || tx.in_msg.source?.address || 'Unknown';
    const to = decodedBody.to_address || 'Unknown';

    return { volume: value, from, to, type, hash: tx.hash || '', timestamp: tx.utime || 0 };
  } catch (error) {
    console.error('Error parsing transaction:', error.message);
    return null;
  }
}

// ==================== УВЕДОМЛЕНИЯ ====================
async function sendNotification(chatId, txData, price) {
  console.log('Sending notification for tx:', txData.hash);
  const buyerInfo = await formatAddress(txData.from);
  const buyerDisplay = buyerInfo.display.length > 20 ? buyerInfo.display.substring(0, 17) + '...' : buyerInfo.display;
  const mc = calculateMC(price);

  let caption;
  if (txData.type === 'BUY') {
    const emoji = getRocketString(txData.volume);
    caption = `<b>NEW BUY!</b> ${emoji}\n\n💎 <b>${formatNumber(txData.volume)} TON</b>\n🦑 <a href="https://tonviewer.com/${buyerInfo.link}">${buyerDisplay}</a> | <a href="https://tonviewer.com/transaction/${txData.hash}">Txn</a>\n🌐 MC: ${mc}`;
  } else {
    const emoji = getHeartString(txData.volume);
    caption = `<b>NEW SELL!</b> ${emoji}\n\n💖 <b>${formatNumber(txData.volume)} TONDEV</b>\n🦑 <a href="https://tonviewer.com/${buyerInfo.link}">${buyerDisplay}</a> | <a href="https://tonviewer.com/transaction/${txData.hash}">Txn</a>\n🌐 MC: ${mc}`;
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: 'DTRADE', url: `https://t.me/dtrade?start=26RoWqxLlD_${TOKEN_ADDRESS}` },
       { text: 'Graph', url: `https://x1000.finance/tokens/${TOKEN_ADDRESS}?ref=nextmayor` }],
      [{ text: 'JOIN HOLDERS CHAT', url: 'https://t.me/tondev_jetton/289' }]
    ]
  };

  try {
    const tokenImage = await getTokenImage();
    if (tokenImage) await bot.sendPhoto(chatId, tokenImage, { caption, parse_mode: 'HTML', reply_markup: keyboard });
    else await bot.sendMessage(chatId, caption, { parse_mode: 'HTML', disable_web_page_preview: false, reply_markup: keyboard });
  } catch (error) { console.error('Error sending notification:', error.message); }
}

// ==================== МОНИТОРИНГ ====================
let lastProcessedTimestamp = Math.floor(Date.now() / 1000) - 600;

async function monitorTransactions() {
  try {
    if (!TON_API_KEY) return;
    const transactions = await getTransactions() || [];
    const price = await getTokenPrice();
    console.log('Fetched transactions:', transactions.length);

    for (const chatId of notificationChats) {
      const minThreshold = chatSettings[chatId]?.minBuyThreshold || 5;
      for (const tx of transactions) {
        if (tx.utime <= lastProcessedTimestamp) continue;
        const txData = parseTransaction(tx, minThreshold, price);
        if (txData) {
          console.log('Transaction passed threshold:', txData);
          await sendNotification(chatId, txData, price);
          if (txData.timestamp > lastProcessedTimestamp) lastProcessedTimestamp = txData.timestamp;
        }
      }
    }
  } catch (error) {
    console.error('Error in monitorTransactions:', error.message);
  }
}

// ==================== КОМАНДА /START ====================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  if (!notificationChats.has(chatId)) notificationChats.add(chatId);
  if (!chatSettings[chatId]) chatSettings[chatId] = { minBuyThreshold: 5 };

  const settings = chatSettings[chatId];

  const message = `
🏴 <b>Token Info</b>
CA: <code>${TOKEN_ADDRESS}</code>
🔹 Minimum buy threshold: <b>${settings.minBuyThreshold} TON</b>
🔹 Notifications for this chat: <b>${notificationChats.has(chatId) ? 'ON' : 'OFF'}</b>

💸 <a href="https://t.me/dtrade?start=26RoWqxLlD_${TOKEN_ADDRESS}">Trade on @dtrade</a>
🏴 <a href="https://bidask.finance/en/app/swap/ton/${TOKEN_ADDRESS}">Swap on Bidask</a>
`;

  try {
    await bot.sendMessage(chatId, message, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (error) {
    console.error('Error sending /start message:', error.message);
  }
});

// ==================== ЗАПУСК ====================
if (TON_API_KEY) setInterval(monitorTransactions, POLL_INTERVAL);

console.log('Bot started. Send /start in your chat to activate notifications.');
process.on('unhandledRejection', console.error);
process.on('SIGINT', () => { console.log('Bot stopped'); process.exit(0); });
