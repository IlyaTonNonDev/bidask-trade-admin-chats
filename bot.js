// Объединённый Telegram Bot
// Функционал: CA info + Модерация (mute/unmute) + Мониторинг покупок и продаж

const TelegramBot = require('node-telegram-bot-api');

// ==================== КОНФИГУРАЦИЯ ====================
const TOKEN_ADDRESS = 'EQDKMh511DOn02mL0nf0JrND0TlkUKmos17eK9zKyGAsjS1K';
const BIDASK_POOL_ADDRESS = '0:ece84060d087c39351665aacb8bc176f603248338af66e4f4ff13529bb594686';
let MIN_BUY_THRESHOLD = 5;
const TOTAL_SUPPLY = 1023257;
const POLL_INTERVAL = 10000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TON_API_KEY = process.env.TON_API_KEY;

if (!TELEGRAM_BOT_TOKEN) {
  console.error('Error: TELEGRAM_BOT_TOKEN is not set');
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
let lastProcessedTimestamp = Math.floor(Date.now() / 1000) - 600;
let adminChatId = null;

// ==================== УТИЛИТЫ ====================

function crc16(data) { /* CRC16 функция, как раньше */ }
function hexToNonBounceable(hexAddress) { /* функция как раньше */ }
async function getAccountInfo(address) { /* функция как раньше */ }
async function formatBuyerAddress(hexAddress) { /* функция как раньше */ }

function getRocketString(volume) {
  const count = Math.min(10, Math.max(1, Math.floor(volume / 5)));
  return '🚀'.repeat(count);
}
function getHeartString(volume) {
  const count = Math.min(10, Math.max(1, Math.floor(volume / 5)));
  return '❤️'.repeat(count);
}
function formatNumber(num) { return new Intl.NumberFormat('en-US').format(num); }
function calculateMC(price) { 
  if (price === null) return '???';
  const mc = price * TOTAL_SUPPLY;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(mc);
}

// ==================== УТИЛИТЫ ДЛЯ МОДЕРАЦИИ ====================
function parseDuration(durationStr) { /* функция как раньше */ }

// ==================== TON API ====================
async function getTransactions() { /* функция как раньше */ }
async function getTokenPrice() { /* функция как раньше */ }
let cachedTokenImage = null;
async function getTokenImage() { /* функция как раньше */ }

function parseBuyTransaction(tx) {
  try {
    if (!tx.in_msg) return null;
    const opName = tx.in_msg.decoded_op_name;
    const decodedBody = tx.in_msg.decoded_body;
    if (opName !== 'bidask_damm_swap' || !decodedBody) return null;
    const nativeAmount = decodedBody.native_amount;
    if (!nativeAmount) return null;
    const value = parseInt(nativeAmount) / 1e9;
    if (value < MIN_BUY_THRESHOLD) return null;
    const buyer = decodedBody.to_address || decodedBody.from_address || tx.in_msg.source?.address || 'Unknown';
    return { volume: value, buyer: buyer, hash: tx.hash || '', timestamp: tx.utime || 0 };
  } catch (e) { console.error('Buy parse error:', e.message); return null; }
}

function parseSellTransaction(tx) {
  try {
    if (!tx.in_msg) return null;
    const opName = tx.in_msg.decoded_op_name;
    const decodedBody = tx.in_msg.decoded_body;
    if (opName !== 'bidask_damm_swap' || !decodedBody) return null;
    const value = parseInt(decodedBody.native_amount) / 1e9;
    if (value < MIN_BUY_THRESHOLD) return null;
    const seller = decodedBody.from_address || tx.in_msg.source?.address || 'Unknown';
    return { volume: value, seller: seller, hash: tx.hash || '', timestamp: tx.utime || 0 };
  } catch (e) { console.error('Sell parse error:', e.message); return null; }
}

// ==================== УВЕДОМЛЕНИЯ ====================
async function sendBuyNotification(buyData, price) {
  if (!adminChatId) return;
  const rockets = getRocketString(buyData.volume);
  const mc = calculateMC(price);
  const buyerInfo = await formatBuyerAddress(buyData.buyer);
  const display = buyerInfo.display.length > 20 ? buyerInfo.display.substring(0,17)+'...' : buyerInfo.display;
  const caption = `<b>NEW BUY!</b> ${rockets}\n\n💎 <b>${formatNumber(buyData.volume)} TON</b>\n🦑 <a href="https://tonviewer.com/${buyerInfo.link}">${display}</a> | <a href="https://tonviewer.com/transaction/${buyData.hash}">Txn</a>\n🌐 MC: ${mc}`;
  const keyboard = { inline_keyboard: [[{text:'DTRADE',url:`https://t.me/dtrade?start=26RoWqxLlD_${TOKEN_ADDRESS}`},{text:'Graph',url:`https://x1000.finance/tokens/${TOKEN_ADDRESS}?ref=nextmayor`}],[{text:'JOIN HOLDERS CHAT',url:'https://t.me/tondev_jetton/289'}]] };
  try {
    const tokenImage = await getTokenImage();
    if (tokenImage) await bot.sendPhoto(adminChatId, tokenImage, { caption, parse_mode:'HTML', reply_markup: keyboard });
    else await bot.sendMessage(adminChatId, caption, { parse_mode:'HTML', disable_web_page_preview:true, reply_markup: keyboard });
  } catch (e) { console.error('Buy notification error:', e.message); }
}

async function sendSellNotification(sellData, price) {
  if (!adminChatId) return;
  const hearts = getHeartString(sellData.volume);
  const mc = calculateMC(price);
  const sellerInfo = await formatBuyerAddress(sellData.seller);
  const display = sellerInfo.display.length > 20 ? sellerInfo.display.substring(0,17)+'...' : sellerInfo.display;
  const caption = `<b>NEW SELL!</b> ${hearts}\n\n💎 <b>${formatNumber(sellData.volume)} TON</b>\n🦑 <a href="https://tonviewer.com/${sellerInfo.link}">${display}</a> | <a href="https://tonviewer.com/transaction/${sellData.hash}">Txn</a>\n🌐 MC: ${mc}`;
  const keyboard = { inline_keyboard: [[{text:'DTRADE',url:`https://t.me/dtrade?start=26RoWqxLlD_${TOKEN_ADDRESS}`},{text:'Graph',url:`https://x1000.finance/tokens/${TOKEN_ADDRESS}?ref=nextmayor`}],[{text:'JOIN HOLDERS CHAT',url:'https://t.me/tondev_jetton/289'}]] };
  try {
    const tokenImage = await getTokenImage();
    if (tokenImage) await bot.sendPhoto(adminChatId, tokenImage, { caption, parse_mode:'HTML', reply_markup: keyboard });
    else await bot.sendMessage(adminChatId, caption, { parse_mode:'HTML', disable_web_page_preview:true, reply_markup: keyboard });
  } catch (e) { console.error('Sell notification error:', e.message); }
}

// ==================== МОНИТОРИНГ ====================
async function monitorTransactions() {
  if (!TON_API_KEY) return;
  const transactions = await getTransactions();
  const price = await getTokenPrice();
  for (const tx of transactions) {
    if (tx.utime <= lastProcessedTimestamp) continue;
    const buyData = parseBuyTransaction(tx);
    if (buyData) await sendBuyNotification(buyData, price);
    const sellData = parseSellTransaction(tx);
    if (sellData) await sendSellNotification(sellData, price);
    if (tx.utime > lastProcessedTimestamp) lastProcessedTimestamp = tx.utime;
  }
}

// ==================== CA INFO ====================
const sendCAInfo = (chatId) => {
  const message = `🏴 [SWAP ON BIDASK](https://bidask.finance/en/app/swap/ton/${TOKEN_ADDRESS})\n💸 [TRADE ON @dtrade](https://t.me/dtrade?start=26RoWqxLlD_${TOKEN_ADDRESS})\nCA: \`${TOKEN_ADDRESS}\``;
  bot.sendMessage(chatId, message, { parse_mode:'Markdown', disable_web_page_preview:true });
};

// ==================== КОМАНДЫ ====================
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  adminChatId = chatId;
  sendCAInfo(chatId);
  if (TON_API_KEY) bot.sendMessage(chatId, `✅ <b>Buy/Sell Bot activated!</b>\nMinimum buy: <b>${MIN_BUY_THRESHOLD} TON</b>\nNotifications will be sent to this chat.`, { parse_mode:'HTML' });
});

bot.onText(/\/CA/i, msg => sendCAInfo(msg.chat.id));
bot.onText(/\/status/, msg => { const uptime=Math.floor(process.uptime()); bot.sendMessage(msg.chat.id, `📊 Bot Status\n✅ Active\n⏱ Uptime: ${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m\n🎯 Min buy: ${MIN_BUY_THRESHOLD} TON\n🔄 Interval: ${POLL_INTERVAL/1000}s`, { parse_mode:'HTML' }); });
bot.onText(/\/volume(?:\s+(\d+(?:\.\d+)?))?/, (msg, match) => { if (msg.chat.id!==adminChatId) return bot.sendMessage(msg.chat.id,'Only admin can use this command.'); const newVol = match[1]?parseFloat(match[1]):null; if(newVol){ MIN_BUY_THRESHOLD=newVol; bot.sendMessage(msg.chat.id, `✅ Threshold changed! Now: ${MIN_BUY_THRESHOLD} TON`, { parse_mode:'HTML' }); } else { bot.sendMessage(msg.chat.id, `Current threshold: ${MIN_BUY_THRESHOLD} TON`, { parse_mode:'HTML' }); } });
bot.onText(/\/help/, msg => { bot.sendMessage(msg.chat.id, `/start /CA /status /volume /help\n/mute /unmute`); });

// ==================== МОДЕРАЦИЯ ====================
bot.onText(/\/mute\s+(.+)/i, async (msg, match) => { /* исправленная логика mute, как раньше */ });
bot.onText(/\/unmute/i, async msg => { /* исправленная логика unmute, как раньше */ });

// ==================== РЕАКЦИЯ НА СООБЩЕНИЯ С "CA" ====================
bot.on('message', msg => { const text = msg.text || ''; if(text.toUpperCase().includes('CA') && !text.startsWith('/')) sendCAInfo(msg.chat.id); });

// ==================== ЗАПУСК ====================
if(TON_API_KEY) setInterval(monitorTransactions, POLL_INTERVAL);
console.log('Bot started, send /start in Telegram to activate notifications');

// Обработка ошибок
process.on('unhandledRejection', error => console.error('Unhandled error:', error));
process.on('SIGINT', () => { console.log('Bot stopped'); process.exit(0); });
