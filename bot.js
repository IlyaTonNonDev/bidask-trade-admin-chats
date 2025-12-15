// Telegram Bot: CA info + Модерация (mute/unmute) + Мониторинг покупок и продаж
require('dotenv').config({ path: './secretkeys.env' });
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs').promises;
const path = require('path');
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

// ==================== WHITELIST ====================
const ALLOWED_USERS = [367102417]; // только этот user может использовать /start

// ==================== ХРАНЕНИЕ НАСТРОЕК ====================
const chatSettings = {}; // { chatId: { minBuyThreshold: 5 } }
const notificationChats = new Set();
const autoRegisteredChats = new Set(); // Чаты, автоматически зарегистрированные как админские

// Файлы для сохранения состояния
const STATE_FILE = path.join(__dirname, 'bot_state.json');

// ==================== КЭШИРОВАНИЕ ДЛЯ ОПТИМИЗАЦИИ ====================
let cachedBotInfo = null; // Кэш информации о боте
const adminCheckCache = new Map(); // Кэш проверок прав администратора: { chatId: { result: boolean, timestamp: number } }
const CACHE_TTL = 5 * 60 * 1000; // 5 минут
const CHECK_DEBOUNCE = 30 * 1000; // 30 секунд между проверками одного чата
const lastCheckTimestamps = new Map(); // Время последней проверки для каждого чата

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
  return '🤬'.repeat(count);
}

function formatNumber(num) { return new Intl.NumberFormat('en-US').format(num); }

function calculateMC(price) {
  if (!price) return '???';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(price * TOTAL_SUPPLY);
}

// Нормализация адреса для сравнения (извлекает hash часть)
function normalizeAddress(address) {
  if (!address) return null;
  
  // Если адрес в формате "workchain:hash", извлекаем hash
  if (address.includes(':')) {
    const parts = address.split(':');
    const hash = parts[parts.length - 1].replace(/^0x/, '').toLowerCase();
    // Убираем ведущие нули для сравнения
    return hash.replace(/^0+/, '') || '0';
  }
  
  // Пытаемся декодировать user-friendly формат (EQD...)
  try {
    if (address.startsWith('EQ') || address.startsWith('UQ')) {
      // Декодируем base64url
      const base64 = address.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
      const decoded = Buffer.from(padded, 'base64');
      if (decoded.length >= 34) {
        // Извлекаем hash (последние 32 байта после флагов и workchain)
        const hash = decoded.slice(2, 34);
        return hash.toString('hex').toLowerCase().replace(/^0+/, '') || '0';
      }
    }
  } catch (e) {
    // Если не получилось декодировать, продолжаем с другими форматами
  }
  
  // Если просто hash, убираем префикс 0x
  const hash = address.replace(/^0x/, '').toLowerCase();
  return hash.replace(/^0+/, '') || '0';
}

// Сравнение двух адресов (учитывает разные форматы)
function addressesMatch(addr1, addr2) {
  if (!addr1 || !addr2) return false;
  
  // Прямое сравнение (если адреса в одинаковом формате)
  if (addr1 === addr2) return true;
  
  // Нормализуем адреса
  const norm1 = normalizeAddress(addr1);
  const norm2 = normalizeAddress(addr2);
  
  // Если нормализация вернула null или пустую строку, используем только прямое сравнение
  if (!norm1 || !norm2 || norm1 === '' || norm2 === '') {
    return false;
  }
  
  // Используем точное сравнение нормализованных адресов
  // Также проверяем, что один адрес заканчивается на другой (для разных форматов)
  return norm1 === norm2 || 
         norm1.endsWith(norm2) || 
         norm2.endsWith(norm1) ||
         addr1.includes(norm2) ||
         addr2.includes(norm1);
}

// ==================== TON API ====================
async function getTransactions() {
  try {
    if (!TON_API_KEY) {
      console.log('[1. GET_TRANSACTIONS] ❌ TON_API_KEY not set');
      return [];
    }
    console.log('[1. GET_TRANSACTIONS] 🔍 Fetching from TON API...');
    const resp = await fetch(`https://tonapi.io/v2/blockchain/accounts/${BIDASK_POOL_ADDRESS}/transactions?limit=20`, {
      headers: { 'Authorization': `Bearer ${TON_API_KEY}`, 'Content-Type': 'application/json' }
    });
    if (!resp.ok) {
      console.error(`[1. GET_TRANSACTIONS] ❌ TON API error: ${resp.status}`);
      throw new Error(`TON API error: ${resp.status}`);
    }
    const data = await resp.json();
    const txCount = (data.transactions || []).length;
    console.log(`[1. GET_TRANSACTIONS] ✅ Received ${txCount} transactions from TON API`);
    return data.transactions || [];
  } catch (error) { 
    console.error('[1. GET_TRANSACTIONS] ❌ Error:', error.message); 
    return []; 
  }
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
    const txHash = tx.hash || 'unknown';
    console.log(`[2. PARSE_TRANSACTION] 🔍 Parsing tx: ${txHash.substring(0, 8)}...`);

    if (!tx.in_msg) {
      console.log(`[2. PARSE_TRANSACTION] ❌ No in_msg in tx ${txHash.substring(0, 8)}`);
      return null;
    }
    const opName = tx.in_msg.decoded_op_name;
    const decodedBody = tx.in_msg.decoded_body;
    console.log(`[2. PARSE_TRANSACTION] 📋 Op name: ${opName}, has decodedBody: ${!!decodedBody}`);
    
    // Поддерживаем bidask_damm_swap (покупки), jetton_transfer и jetton_notify (продажи на стороне пула)
    if ((opName !== 'bidask_damm_swap' && opName !== 'jetton_transfer' && opName !== 'jetton_notify') || !decodedBody) {
      console.log(`[2. PARSE_TRANSACTION] ❌ Op name is not bidask_damm_swap/jetton_transfer/jetton_notify, or no decodedBody`);
      return null;
    }
    
    // Для bidask_damm_swap используем decodedBody напрямую (покупки)
    // Для jetton_transfer и jetton_notify нужно проверить forward_payload (продажи)
    let actualDecodedBody = decodedBody;
    if (opName === 'bidask_damm_swap') {
      // Для покупок decodedBody уже содержит нужные данные
      actualDecodedBody = decodedBody;
      console.log(`[2. PARSE_TRANSACTION] 🔍 bidask_damm_swap detected (BUY), using decodedBody directly`);
    } else if ((opName === 'jetton_transfer' || opName === 'jetton_notify') && decodedBody.forward_payload) {
      // Для jetton transfer/notify, bidask_damm_swap находится в forward_payload
      console.log(`[2. PARSE_TRANSACTION] 🔍 ${opName} detected, checking forward_payload`);
      if (decodedBody.forward_payload.value?.value) {
        // forward_payload содержит вложенную структуру с value
        actualDecodedBody = decodedBody.forward_payload.value.value;
        console.log(`[2. PARSE_TRANSACTION] ✅ Found BidaskDammSwap data in forward_payload.value.value`);
      } else if (decodedBody.forward_payload.decoded_body) {
        actualDecodedBody = decodedBody.forward_payload.decoded_body;
        console.log(`[2. PARSE_TRANSACTION] ✅ Found decoded_body in forward_payload`);
      }
    }
    
    // Логируем структуру decodedBody для отладки
    console.log(`[2. PARSE_TRANSACTION] 🔬 decodedBody keys:`, Object.keys(actualDecodedBody));
    console.log(`[2. PARSE_TRANSACTION] 🔬 decodedBody.native_amount:`, actualDecodedBody.native_amount);
    console.log(`[2. PARSE_TRANSACTION] 🔬 decodedBody.jetton:`, actualDecodedBody.jetton?.substring(0, 20));
    console.log(`[2. PARSE_TRANSACTION] 🔬 decodedBody.amount:`, actualDecodedBody.amount);
    console.log(`[2. PARSE_TRANSACTION] 🔬 decodedBody.from_address:`, actualDecodedBody.from_address?.substring(0, 20));
    
    // Для jetton_transfer, адрес токена нужно извлечь из destination (адрес пула получает jetton)
    // Но на самом деле, мы получаем транзакции пула, поэтому destination должен быть сам пул
    // Адрес токена может быть в jetton_wallet или нужно проверить входящий jetton transfer
    // Для начала попробуем найти адрес токена через source транзакции или через анализ структуры
    let jettonAddress = null;
    if (opName === 'jetton_transfer') {
      // Для jetton_transfer на стороне пула, нужно определить какой токен получен
      // Можем использовать destination пула и найти jetton wallet адрес
      // Или использовать информацию из tx если она есть
      // Пока используем null и будем полагаться на проверку через forward_payload
      jettonAddress = decodedBody.jetton_master?.address || decodedBody.jetton_wallet?.address || null;
      console.log(`[2. PARSE_TRANSACTION] 🔬 jetton_transfer: jetton_master=${decodedBody.jetton_master?.address?.substring(0, 20)}, jetton_wallet=${decodedBody.jetton_wallet?.address?.substring(0, 20)}`);
    } else {
      jettonAddress = actualDecodedBody.jetton;
    }
    console.log(`[2. PARSE_TRANSACTION] 🔬 jettonAddress (from ${opName}):`, jettonAddress?.substring(0, 20) || 'null');

    let value, type, tondevAmount;

    // Покупка: входящее сообщение содержит native TON на пул
    if (actualDecodedBody.native_amount) { 
      value = parseInt(actualDecodedBody.native_amount) / 1e9;
      type = 'BUY';
      console.log(`[2. PARSE_TRANSACTION] 💰 BUY detected: ${value} TON, threshold: ${minThreshold}`);
      if (value < minThreshold) {
        console.log(`[2. PARSE_TRANSACTION] ❌ BUY below threshold: ${value} < ${minThreshold}`);
        return null;
      }
      console.log(`[2. PARSE_TRANSACTION] ✅ BUY passed threshold: ${value} >= ${minThreshold}`);
      
      // Для покупки сразу возвращаем результат
      const from = actualDecodedBody.from_address || tx.in_msg.source?.address || 'Unknown';
      const to = actualDecodedBody.to_address || 'Unknown';
      const result = { 
        volume: value, 
        from, 
        to, 
        type, 
        hash: tx.hash || '', 
        timestamp: tx.utime || 0 
      };
      console.log(`[2. PARSE_TRANSACTION] ✅ Parsed successfully: ${JSON.stringify(result)}`);
      return result;
    } 
    // Продажа: входящее сообщение содержит jetton transfer/notify с TONDEV на пул
    // Для bidask_damm_swap проверяем jetton, для jetton_transfer/jetton_notify это уже продажа по определению
    let jettonMatches = false;
    if (opName === 'jetton_transfer' || opName === 'jetton_notify') {
      // Если это jetton_transfer или jetton_notify на наш пул, это продажа
      jettonMatches = true;
      console.log(`[2. PARSE_TRANSACTION] 🔍 ${opName} on pool = SELL (assuming correct token)`);
    } else {
      // Для bidask_damm_swap проверяем адрес токена
      const tokenAddressNormalized = normalizeAddress(TOKEN_ADDRESS);
      const jettonAddressNormalized = normalizeAddress(jettonAddress);
      jettonMatches = jettonAddress === TOKEN_ADDRESS || 
                      (tokenAddressNormalized && jettonAddressNormalized && tokenAddressNormalized === jettonAddressNormalized);
      console.log(`[2. PARSE_TRANSACTION] 🔍 Jetton comparison: jetton=${jettonAddress?.substring(0, 20) || 'none'}..., TOKEN_ADDRESS=${TOKEN_ADDRESS.substring(0, 20)}..., matches=${jettonMatches}`);
    }
    
    if (jettonMatches) {
      console.log(`[2. PARSE_TRANSACTION] 🔍 SELL candidate detected (jetton matches)`); 
      // Количество проданных TONDEV (для отображения)
      // Для jetton_transfer/jetton_notify amount находится в decodedBody, для bidask_damm_swap в actualDecodedBody
      const amount = (opName === 'jetton_transfer' || opName === 'jetton_notify') ? decodedBody.amount : actualDecodedBody.amount;
      if (!amount) {
        console.log(`[2. PARSE_TRANSACTION] ❌ No amount found for SELL. decodedBody.amount=${decodedBody.amount}, actualDecodedBody.amount=${actualDecodedBody.amount}`);
        return null;
      }
      tondevAmount = parseInt(amount) / 1e9;
      console.log(`[2. PARSE_TRANSACTION] 💎 TONDEV amount: ${tondevAmount}`);
      
      // Найти исходящее сообщение с TON от пула к продавцу
      // Для jetton_transfer адрес продавца в decodedBody.response_destination или source
      // Для jetton_notify адрес продавца в decodedBody.sender
      let sellerAddress = null;
      if (opName === 'jetton_notify') {
        sellerAddress = decodedBody.sender || tx.in_msg.source?.address;
        console.log(`[2. PARSE_TRANSACTION] 🔍 jetton_notify seller lookup: sender=${decodedBody.sender}, in_msg.source=${tx.in_msg.source?.address}`);
      } else if (opName === 'jetton_transfer') {
        sellerAddress = decodedBody.response_destination?.address || 
                       decodedBody.response_destination ||
                       decodedBody.source?.address || 
                       decodedBody.source ||
                       tx.in_msg.source?.address;
        console.log(`[2. PARSE_TRANSACTION] 🔍 jetton_transfer seller lookup: response_destination=${decodedBody.response_destination?.address || decodedBody.response_destination}, source=${decodedBody.source?.address || decodedBody.source}, in_msg.source=${tx.in_msg.source?.address}`);
      } else {
        sellerAddress = actualDecodedBody.from_address || tx.in_msg.source?.address;
      }
      console.log(`[2. PARSE_TRANSACTION] 🦑 Seller address: ${sellerAddress?.substring ? sellerAddress.substring(0, 20) : sellerAddress || 'NOT FOUND'}...`);
      if (!sellerAddress) {
        console.log(`[2. PARSE_TRANSACTION] ❌ SELL detected but no seller address found`);
        console.log(`[2. PARSE_TRANSACTION] 🔍 Full decodedBody for seller lookup:`, JSON.stringify(decodedBody, null, 2));
        return null;
      }

      // Ищем исходящее сообщение с TON, адресованное продавцу
      let tonReceived = null;
      
      console.log(`[2. PARSE_TRANSACTION] 🔍 Looking for TON out message in out_msgs (count: ${tx.out_msgs?.length || 0})`);
      // Проверяем out_msgs
      if (tx.out_msgs && Array.isArray(tx.out_msgs)) {
        for (let i = 0; i < tx.out_msgs.length; i++) {
          const outMsg = tx.out_msgs[i];
          const destination = outMsg.destination?.address || outMsg.destination;
          console.log(`[2. PARSE_TRANSACTION]   out_msg[${i}]: destination=${destination?.substring(0, 20) || 'none'}..., value=${outMsg.value || 'none'}, jetton=${outMsg.jetton ? 'yes' : 'no'}`);
          if (destination && addressesMatch(destination, sellerAddress)) {
            console.log(`[2. PARSE_TRANSACTION]   ✅ Destination matches seller!`);
            // Проверяем value (native TON) - это не jetton transfer
            if (outMsg.value && !outMsg.jetton) {
              tonReceived = parseInt(outMsg.value) / 1e9;
              console.log(`[2. PARSE_TRANSACTION]   ✅ Found TON in out_msg: ${tonReceived} TON`);
              break;
            } else {
              console.log(`[2. PARSE_TRANSACTION]   ⚠️ Matched but no TON value (value=${outMsg.value}, jetton=${!!outMsg.jetton})`);
            }
          }
        }
      }

      // Если не нашли в out_msgs, проверяем actions (альтернативный способ)
      if (tonReceived === null) {
        console.log(`[2. PARSE_TRANSACTION] 🔍 Looking in actions (count: ${tx.actions?.length || 0})`);
        if (tx.actions && Array.isArray(tx.actions)) {
          for (let i = 0; i < tx.actions.length; i++) {
            const action = tx.actions[i];
          // Ищем действие отправки TON (не jetton)
          if (action.type === 'TonTransfer' || (action.TonTransfer && !action.JettonTransfer)) {
            const actionDestination = action.destination?.address || action.TonTransfer?.destination?.address;
              const actionValue = action.amount || action.TonTransfer?.amount || action.value;
              console.log(`[2. PARSE_TRANSACTION]   action[${i}]: type=${action.type}, destination=${actionDestination?.substring(0, 20) || 'none'}..., amount=${actionValue || 'none'}`);
              if (actionDestination && addressesMatch(actionDestination, sellerAddress)) {
                console.log(`[2. PARSE_TRANSACTION]   ✅ Destination matches seller in action!`);
              if (actionValue) {
                tonReceived = parseInt(actionValue) / 1e9;
                  console.log(`[2. PARSE_TRANSACTION]   ✅ Found TON in action: ${tonReceived} TON`);
                break;
                }
              }
            }
          }
        }
      }

      if (tonReceived === null) {
        console.log(`[2. PARSE_TRANSACTION] ❌ SELL detected but no TON out message found for seller`);
        console.log(`[2. PARSE_TRANSACTION] 🔍 Debug: out_msgs=${JSON.stringify(tx.out_msgs?.map(m => ({ dest: m.destination?.address, value: m.value, jetton: m.jetton })))}`);
        console.log(`[2. PARSE_TRANSACTION] 🔍 Debug: actions=${JSON.stringify(tx.actions?.map(a => ({ type: a.type, dest: a.destination?.address || a.TonTransfer?.destination?.address })))}`);
        return null;
      }

      // Порог применяется к сумме TON, которую получил продавец
      value = tonReceived;
      type = 'SELL';
      console.log(`[2. PARSE_TRANSACTION] 💰 SELL detected: ${tondevAmount} TONDEV sold, ${value} TON received, threshold: ${minThreshold}`);
      if (value < minThreshold) {
        console.log(`[2. PARSE_TRANSACTION] ❌ SELL below threshold: ${value} < ${minThreshold}`);
        return null;
      }
      console.log(`[2. PARSE_TRANSACTION] ✅ SELL passed threshold: ${value} >= ${minThreshold}`);
    } else return null;

    let from = 'Unknown';
    if (opName === 'jetton_notify') {
      from = decodedBody.sender || tx.in_msg.source?.address || 'Unknown';
    } else if (opName === 'jetton_transfer') {
      from = decodedBody.response_destination?.address || decodedBody.response_destination || decodedBody.source?.address || decodedBody.source || tx.in_msg.source?.address || 'Unknown';
    } else {
      from = actualDecodedBody.from_address || tx.in_msg.source?.address || 'Unknown';
    }
    const to = actualDecodedBody.to_address || 'Unknown';

    // Для продажи volume - это количество TONDEV (для отображения), но проверка порога уже выполнена по TON
    const result = { 
      volume: type === 'SELL' ? tondevAmount : value, 
      from, 
      to, 
      type, 
      hash: tx.hash || '', 
      timestamp: tx.utime || 0 
    };
    console.log(`[2. PARSE_TRANSACTION] ✅ Parsed successfully: ${JSON.stringify(result)}`);
    return result;
  } catch (error) {
    console.error(`[2. PARSE_TRANSACTION] ❌ Error parsing transaction:`, error.message);
    console.error(error.stack);
    return null;
  }
}

// ==================== УВЕДОМЛЕНИЯ ====================
async function sendNotification(chatId, txData, price) {
  console.log(`[4. SEND_NOTIFICATION] 📤 Sending notification for tx: ${txData.hash.substring(0, 8)}..., type: ${txData.type}, chatId: ${chatId}`);
  const buyerInfo = await formatAddress(txData.from);
  const buyerDisplay = buyerInfo.display.length > 20 ? buyerInfo.display.substring(0, 17) + '...' : buyerInfo.display;
  const mc = calculateMC(price);

  let caption;
  if (txData.type === 'BUY') {
    const emoji = getRocketString(txData.volume);
    caption = `<b>NEW BUY!</b> ${emoji}\n\n💎 <b>${formatNumber(txData.volume)} TON</b>\n🦑 <a href="https://tonviewer.com/${buyerInfo.link}">${buyerDisplay}</a> | <a href="https://tonviewer.com/transaction/${txData.hash}">Txn</a>\n🌐 MC: ${mc}`;
  } else {
    const emoji = getHeartString(txData.volume);
    caption = `<b>NEW SELL!</b> ${emoji}\n\n🤬 <b>${formatNumber(txData.volume)} TONDEV</b>\n🦑 <a href="https://tonviewer.com/${buyerInfo.link}">${buyerDisplay}</a> | <a href="https://tonviewer.com/transaction/${txData.hash}">Txn</a>\n🌐 MC: ${mc}`;
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
    if (tokenImage) {
      await bot.sendPhoto(chatId, tokenImage, { caption, parse_mode: 'HTML', reply_markup: keyboard });
      console.log(`[4. SEND_NOTIFICATION] ✅ Notification sent with photo to chat ${chatId}`);
    } else {
      await bot.sendMessage(chatId, caption, { parse_mode: 'HTML', disable_web_page_preview: false, reply_markup: keyboard });
      console.log(`[4. SEND_NOTIFICATION] ✅ Notification sent as message to chat ${chatId}`);
    }
  } catch (error) { 
    console.error(`[4. SEND_NOTIFICATION] ❌ Error sending notification:`, error.message);
    console.error(error.stack);
  }
}

// ==================== МОНИТОРИНГ ====================
let lastProcessedTimestamp = Math.floor(Date.now() / 1000) - 600; // Обрабатываем транзакции за последние 10 минут

async function monitorTransactions() {
  try {
    if (!TON_API_KEY) {
      console.log('[MONITOR] ❌ TON_API_KEY not set, skipping');
      return;
    }
    const transactions = await getTransactions() || [];
    const price = await getTokenPrice();
    console.log(`[MONITOR] 📊 Processing ${transactions.length} transactions, price: ${price || 'N/A'}, lastProcessedTimestamp: ${lastProcessedTimestamp}`);

    if (notificationChats.size === 0) {
      console.log('[MONITOR] ⚠️ No notification chats registered');
      return;
    }

    for (const chatId of notificationChats) {
      // Дополнительная проверка: отправляем уведомления только в группы (chatId < 0)
      if (chatId > 0) {
        console.log(`[MONITOR] ⚠️ Skipping personal chat ${chatId} - notifications only for groups`);
        continue;
      }
      
      const minThreshold = chatSettings[chatId]?.minBuyThreshold || 5;
      console.log(`[MONITOR] 💬 Processing chat ${chatId} with threshold ${minThreshold} TON`);
      
      let processedCount = 0;
      let skippedOldCount = 0;
      let bidaskSwapCount = 0;
      let otherOpsCount = 0;
      
      // Сначала посчитаем статистику по операциям и выведем структуру первой транзакции
      for (const tx of transactions) {
        const opName = tx.in_msg?.decoded_op_name;
        if (opName === 'bidask_damm_swap') {
          bidaskSwapCount++;
        } else if (opName) {
          otherOpsCount++;
        }
      }
      console.log(`[MONITOR] 📊 Transaction stats: bidask_damm_swap=${bidaskSwapCount}, other_ops=${otherOpsCount}, no_op=${transactions.length - bidaskSwapCount - otherOpsCount}`);
      
      // Выводим структуру первой новой транзакции для отладки
      const newTxs = transactions.filter(tx => tx.utime > lastProcessedTimestamp);
      if (newTxs.length > 0) {
        const firstNewTx = newTxs[0];
        console.log(`[MONITOR] 🔬 Debug first new tx structure:`, JSON.stringify({
          hash: firstNewTx.hash?.substring(0, 16),
          utime: firstNewTx.utime,
          in_msg: {
            decoded_op_name: firstNewTx.in_msg?.decoded_op_name,
            has_decoded_body: !!firstNewTx.in_msg?.decoded_body,
            source: firstNewTx.in_msg?.source?.address?.substring(0, 20),
            destination: firstNewTx.in_msg?.destination?.address?.substring(0, 20),
          },
          out_msgs_count: firstNewTx.out_msgs?.length || 0,
          actions_count: firstNewTx.actions?.length || 0,
        }, null, 2));
      }
      
      for (const tx of transactions) {
        const txHash = tx.hash?.substring(0, 8) || 'unknown';
        const opName = tx.in_msg?.decoded_op_name || 'no op_name';
        const hasDecodedBody = !!tx.in_msg?.decoded_body;
        console.log(`[MONITOR] 🔍 Tx ${txHash}... | op: ${opName} | has_decoded_body: ${hasDecodedBody} | utime: ${tx.utime}`);
        
        if (tx.utime <= lastProcessedTimestamp) {
          skippedOldCount++;
          console.log(`[MONITOR] ⏭️ Skipping old tx (utime ${tx.utime} <= ${lastProcessedTimestamp})`);
          continue;
        }
        
        console.log(`[3. CHECK_THRESHOLD] 🔍 Processing new tx, passing to parser...`);
        const txData = parseTransaction(tx, minThreshold, price);
        if (txData) {
          console.log(`[3. CHECK_THRESHOLD] ✅ Transaction passed all checks:`, txData);
          await sendNotification(chatId, txData, price);
          if (txData.timestamp > lastProcessedTimestamp) {
            console.log(`[MONITOR] 📅 Updating lastProcessedTimestamp: ${lastProcessedTimestamp} -> ${txData.timestamp}`);
            lastProcessedTimestamp = txData.timestamp;
          }
          processedCount++;
        } else {
          console.log(`[3. CHECK_THRESHOLD] ❌ Transaction did not pass parsing/threshold check`);
        }
      }
      
      console.log(`[MONITOR] 📈 Summary for chat ${chatId}: processed=${processedCount}, skipped_old=${skippedOldCount}, total=${transactions.length}`);
    }
  } catch (error) {
    console.error('[MONITOR] ❌ Error in monitorTransactions:', error.message);
    console.error(error.stack);
  }
}

// ==================== ПРОВЕРКА ПРАВ АДМИНИСТРАТОРА ====================
async function isAdmin(chatId, userId) {
  try {
    // В приватных чатах все пользователи - админы
    if (chatId > 0) {
      return true;
    }
    
    // В группах/каналах проверяем права
    const member = await bot.getChatMember(chatId, userId);
    return member.status === 'creator' || member.status === 'administrator';
  } catch (error) {
    console.error(`[isAdmin] Error checking admin status:`, error.message);
    return false;
  }
}

// Получение информации о боте с кэшированием
async function getBotInfo() {
  if (!cachedBotInfo) {
    cachedBotInfo = await bot.getMe();
  }
  return cachedBotInfo;
}

// Проверка, является ли бот администратором группы с правом отправки сообщений (с кэшированием)
async function isBotAdminWithSendPermission(chatId) {
  try {
    if (chatId > 0) {
      return false; // Личные чаты не нужны
    }
    
    // Проверяем кэш
    const cached = adminCheckCache.get(chatId);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      return cached.result;
    }
    
    // Дебаунсинг: если проверяли недавно, используем кэш или возвращаем false
    const lastCheck = lastCheckTimestamps.get(chatId);
    if (lastCheck && (Date.now() - lastCheck) < CHECK_DEBOUNCE) {
      // Используем кэшированный результат, если есть, иначе возвращаем false
      if (cached) {
        return cached.result;
      }
      return false;
    }
    
    lastCheckTimestamps.set(chatId, Date.now());
    
    const botInfo = await getBotInfo();
    const member = await bot.getChatMember(chatId, botInfo.id);
    
    let result = false;
    if (member.status === 'creator') {
      result = true;
    } else if (member.status === 'administrator') {
      // Проверяем, что бот может отправлять сообщения
      result = member.can_post_messages !== false && 
               member.can_send_messages !== false &&
               member.can_send_media_messages !== false;
    }
    
    // Сохраняем в кэш (включая отрицательные результаты)
    adminCheckCache.set(chatId, {
      result,
      timestamp: Date.now()
    });
    
    // Очищаем старые записи из кэша (раз в ~100 проверок)
    if (adminCheckCache.size > 1000) {
      const now = Date.now();
      for (const [cachedChatId, cacheData] of adminCheckCache.entries()) {
        if (now - cacheData.timestamp > CACHE_TTL) {
          adminCheckCache.delete(cachedChatId);
        }
      }
    }
    
    return result;
  } catch (error) {
    console.error(`[isBotAdminWithSendPermission] Error:`, error.message);
    // При ошибке не кэшируем, чтобы попробовать еще раз
    return false;
  }
}

// Сохранение состояния в файл
async function saveState() {
  try {
    const state = {
      notificationChats: Array.from(notificationChats),
      autoRegisteredChats: Array.from(autoRegisteredChats),
      chatSettings: chatSettings
    };
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    console.log(`[SAVE_STATE] ✅ State saved: ${notificationChats.size} chats`);
  } catch (error) {
    console.error(`[SAVE_STATE] ❌ Error saving state:`, error.message);
  }
}

// Загрузка состояния из файла
async function loadState() {
  try {
    const data = await fs.readFile(STATE_FILE, 'utf8');
    const state = JSON.parse(data);
    
    if (state.notificationChats && Array.isArray(state.notificationChats)) {
      state.notificationChats.forEach(chatId => notificationChats.add(chatId));
    }
    
    if (state.autoRegisteredChats && Array.isArray(state.autoRegisteredChats)) {
      state.autoRegisteredChats.forEach(chatId => autoRegisteredChats.add(chatId));
    }
    
    if (state.chatSettings && typeof state.chatSettings === 'object') {
      Object.assign(chatSettings, state.chatSettings);
    }
    
    console.log(`[LOAD_STATE] ✅ State loaded: ${notificationChats.size} chats`);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(`[LOAD_STATE] ℹ️ No state file found, starting fresh`);
    } else {
      console.error(`[LOAD_STATE] ❌ Error loading state:`, error.message);
    }
    return false;
  }
}

// Автоматическая регистрация группы, если бот является администратором
async function autoRegisterChatIfAdmin(chatId) {
  if (chatId > 0) {
    return; // Пропускаем личные чаты
  }
  
  if (notificationChats.has(chatId)) {
    return; // Уже зарегистрирован
  }
  
  try {
    const isAdmin = await isBotAdminWithSendPermission(chatId);
    if (isAdmin) {
      notificationChats.add(chatId);
      autoRegisteredChats.add(chatId);
      if (!chatSettings[chatId]) {
        chatSettings[chatId] = { minBuyThreshold: 5 };
      }
      await saveState(); // Сохраняем состояние после добавления
      console.log(`[AUTO_REGISTER] ✅ Auto-registered group chat ${chatId} (bot is admin)`);
    }
  } catch (error) {
    console.error(`[AUTO_REGISTER] Error checking chat ${chatId}:`, error.message);
  }
}

// ==================== КОМАНДА /START ====================
bot.onText(/\/start/, async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const username = msg.from.username || 'no username';

    console.log(`[/START] 🔔 Command received from user ${userId} (@${username}) in chat ${chatId}`);
    console.log(`[/START] 📋 ALLOWED_USERS: ${JSON.stringify(ALLOWED_USERS)}`);

    // Access control
    if (!ALLOWED_USERS.includes(userId)) {
        console.log(`[/START] ❌ Access denied for user ${userId}`);
        try {
            await bot.sendMessage(
                chatId,
            "⛔ У вас нет доступа к этому боту."
        );
            console.log(`[/START] ✅ Denied message sent to chat ${chatId}`);
        } catch (error) {
            console.error(`[/START] ❌ Error sending denied message:`, error.message);
        }
        return;
    }

    console.log(`[/START] ✅ Access granted for user ${userId}`);

    // Автоматически регистрируем группу, если бот является администратором
    if (chatId < 0) {
        await autoRegisterChatIfAdmin(chatId);
        
        // Если не удалось автоматически зарегистрировать, добавляем вручную
        if (!notificationChats.has(chatId)) {
            notificationChats.add(chatId);
            if (!chatSettings[chatId]) {
                chatSettings[chatId] = { minBuyThreshold: 5 };
            }
            await saveState(); // Сохраняем состояние после добавления
            console.log(`[/START] ✅ Group chat ${chatId} added to notification list (manual)`);
        }
    } else {
        console.log(`[/START] ⚠️ Personal chat ${chatId} ignored - notifications only work in groups`);
        await bot.sendMessage(chatId, "⚠️ Уведомления работают только в группах. Добавьте бота в группу как администратора с правом отправки сообщений.", { parse_mode: 'HTML' });
        // Не прерываем выполнение, показываем информацию о токене
    }
    if (!chatSettings[chatId]) chatSettings[chatId] = { minBuyThreshold: 5 };

    const settings = chatSettings[chatId];

    const message = `
🏴 <b>Token Info</b>
CA: <code>${TOKEN_ADDRESS}</code>
🔹 Minimum buy threshold: <b>${settings.minBuyThreshold} TON</b>
🔹 Notifications for this chat: <b>${chatId < 0 && notificationChats.has(chatId) ? 'ON' : 'OFF'}</b>${chatId > 0 ? '\n\n⚠️ Уведомления работают только в группах' : ''}

💸 <a href="https://t.me/dtrade?start=26RoWqxLlD_${TOKEN_ADDRESS}">Trade on @dtrade</a>
🏴 <a href="https://bidask.finance/en/app/swap/ton/${TOKEN_ADDRESS}">Swap on Bidask</a>
`;

    try {
        await bot.sendMessage(chatId, message, { parse_mode: 'HTML', disable_web_page_preview: true });
        console.log(`[/START] ✅ Start message sent successfully to chat ${chatId}`);
    } catch (error) {
        console.error(`[/START] ❌ Error sending /start message:`, error.message);
        console.error(error.stack);
    }
});

// ==================== КОМАНДА /CA ====================
bot.onText(/\/ca$/i, async (msg) => {
    const chatId = msg.chat.id;

    const message = `🏴 <b>Contract Address</b>\n\n<code>${TOKEN_ADDRESS}</code>\n\n💸 <a href="https://t.me/dtrade?start=26RoWqxLlD_${TOKEN_ADDRESS}">Trade on @dtrade</a>\n🏴 <a href="https://bidask.finance/en/app/swap/ton/${TOKEN_ADDRESS}">Swap on Bidask</a>`;
    
    try {
        await bot.sendMessage(chatId, message, { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (error) {
        console.error(`[/CA] Error:`, error.message);
    }
});

// ==================== КОМАНДА /STATUS ====================
bot.onText(/\/status$/i, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!(await isAdmin(chatId, userId))) {
        return bot.sendMessage(chatId, "⛔ Эта команда доступна только администраторам чата.");
    }

    const settings = chatSettings[chatId] || { minBuyThreshold: 5 };
    const isMonitoring = notificationChats.has(chatId);
    const price = await getTokenPrice();
    const mc = calculateMC(price);

    const message = `📊 <b>Bot Status</b>\n\n` +
        `🔹 Notifications: <b>${isMonitoring ? 'ON' : 'OFF'}</b>\n` +
        `🔹 Minimum threshold: <b>${settings.minBuyThreshold} TON</b>\n` +
        `🔹 Token price: <b>$${price ? price.toFixed(8) : 'N/A'}</b>\n` +
        `🔹 Market Cap: <b>${mc}</b>\n` +
        `🔹 Monitoring interval: <b>${POLL_INTERVAL / 1000}s</b>`;

    try {
        await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
    } catch (error) {
        console.error(`[/STATUS] Error:`, error.message);
    }
});

// ==================== КОМАНДА /VOLUME ====================
bot.onText(/\/volume(?:\s+(\d+(?:\.\d+)?))?/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!(await isAdmin(chatId, userId))) {
        return bot.sendMessage(chatId, "⛔ Эта команда доступна только администраторам чата.");
    }

    if (!chatSettings[chatId]) {
        chatSettings[chatId] = { minBuyThreshold: 5 };
    }

    if (match[1]) {
        // Установить новое значение
        const newThreshold = parseFloat(match[1]);
        if (isNaN(newThreshold) || newThreshold <= 0) {
            return bot.sendMessage(chatId, "❌ Неверное значение. Используйте положительное число (например: /volume 10)");
        }
        chatSettings[chatId].minBuyThreshold = newThreshold;
        await bot.sendMessage(chatId, `✅ Минимальный порог изменен на <b>${newThreshold} TON</b>`, { parse_mode: 'HTML' });
    } else {
        // Показать текущее значение
        const currentThreshold = chatSettings[chatId].minBuyThreshold || 5;
        await bot.sendMessage(chatId, `🔹 Текущий минимальный порог: <b>${currentThreshold} TON</b>\n\nИспользуйте <code>/volume [число]</code> для изменения`, { parse_mode: 'HTML' });
    }
});

// ==================== КОМАНДА /HELP ====================
bot.onText(/\/help$/i, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!(await isAdmin(chatId, userId))) {
        return bot.sendMessage(chatId, "⛔ Эта команда доступна только администраторам чата.");
    }

    const message = `📖 <b>Доступные команды</b>\n\n` +
        `<b>Для всех:</b>\n` +
        `/start - Активировать бота и показать информацию о токене\n\n` +
        `<b>Только для администраторов:</b>\n` +
        `/ca - Показать адрес контракта (CA)\n` +
        `/status - Показать статус бота\n` +
        `/volume [число] - Показать/изменить минимальный порог (по умолчанию 5 TON)\n` +
        `/mute [время] - Заглушить пользователя (ответьте на сообщение)\n` +
        `/unmute - Разглушить пользователя (ответьте на сообщение)\n` +
        `/help - Показать эту справку\n\n` +
        `💡 Бот отправляет уведомления о покупках и продажах токена, превышающих минимальный порог.`;

    try {
        await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
    } catch (error) {
        console.error(`[/HELP] Error:`, error.message);
    }
});

// ==================== КОМАНДА /MUTE ====================
bot.onText(/\/mute(?:\s+(\d+)([mhd]))?/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!(await isAdmin(chatId, userId))) {
        return bot.sendMessage(chatId, "⛔ Эта команда доступна только администраторам чата.");
    }

    // Проверяем, что команда была отправлена как ответ на сообщение
    if (!msg.reply_to_message) {
        return bot.sendMessage(chatId, "❌ Ответьте на сообщение пользователя, которого хотите заглушить.\n\nИспользование: Ответьте на сообщение и отправьте <code>/mute 30m</code> (30m = 30 минут, 1h = 1 час, 7d = 7 дней)", { parse_mode: 'HTML' });
    }

    const targetUserId = msg.reply_to_message.from.id;
    
    // Парсим время
    let muteDuration = 30 * 60 * 1000; // По умолчанию 30 минут
    if (match[1] && match[2]) {
        const value = parseInt(match[1]);
        const unit = match[2].toLowerCase();
        switch (unit) {
            case 'm': muteDuration = value * 60 * 1000; break;
            case 'h': muteDuration = value * 60 * 60 * 1000; break;
            case 'd': muteDuration = value * 24 * 60 * 60 * 1000; break;
        }
    }

    const muteUntil = Date.now() + muteDuration;
    const muteUntilDate = new Date(muteUntil);

    try {
        await bot.restrictChatMember(chatId, targetUserId, {
            until_date: Math.floor(muteUntil / 1000),
            permissions: {
                can_send_messages: false,
                can_send_media_messages: false,
                can_send_polls: false,
                can_send_other_messages: false,
                can_add_web_page_previews: false
            }
        });

        const durationText = match[1] && match[2] ? `${match[1]}${match[2]}` : '30 минут';
        await bot.sendMessage(chatId, `🔇 Пользователь @${msg.reply_to_message.from.username || 'пользователь'} заглушен на ${durationText}.\n\nРазблокировка: ${muteUntilDate.toLocaleString('ru-RU')}`, { parse_mode: 'HTML' });
    } catch (error) {
        console.error(`[/MUTE] Error:`, error.message);
        await bot.sendMessage(chatId, `❌ Ошибка: ${error.message}\n\nУбедитесь, что бот имеет права администратора и может ограничивать пользователей.`);
    }
});

// ==================== КОМАНДА /UNMUTE ====================
bot.onText(/\/unmute$/i, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!(await isAdmin(chatId, userId))) {
        return bot.sendMessage(chatId, "⛔ Эта команда доступна только администраторам чата.");
    }

    // Проверяем, что команда была отправлена как ответ на сообщение
    if (!msg.reply_to_message) {
        return bot.sendMessage(chatId, "❌ Ответьте на сообщение пользователя, которого хотите разглушить.\n\nИспользование: Ответьте на сообщение и отправьте <code>/unmute</code>", { parse_mode: 'HTML' });
    }

    const targetUserId = msg.reply_to_message.from.id;

    try {
        await bot.restrictChatMember(chatId, targetUserId, {
            permissions: {
                can_send_messages: true,
                can_send_media_messages: true,
                can_send_polls: true,
                can_send_other_messages: true,
                can_add_web_page_previews: true
            }
        });

        await bot.sendMessage(chatId, `🔊 Пользователь @${msg.reply_to_message.from.username || 'пользователь'} разглушен.`);
    } catch (error) {
        console.error(`[/UNMUTE] Error:`, error.message);
        await bot.sendMessage(chatId, `❌ Ошибка: ${error.message}\n\nУбедитесь, что бот имеет права администратора и может ограничивать пользователей.`);
    }
});

// ==================== ОБРАБОТЧИК СООБЩЕНИЙ ДЛЯ АВТОРЕГИСТРАЦИИ ====================
// Обработчик всех сообщений для автоматической регистрации групп
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    
    // Автоматически регистрируем группу, если бот является администратором
    // Проверяем только если чат еще не зарегистрирован
    if (chatId < 0 && !notificationChats.has(chatId)) {
        await autoRegisterChatIfAdmin(chatId);
    }
});

// ==================== ЗАПУСК ====================
// Загружаем сохраненное состояние при старте
(async () => {
  await loadState();
  
if (TON_API_KEY) setInterval(monitorTransactions, POLL_INTERVAL);

  console.log('Bot started. Bot will automatically send notifications to groups where it is an admin with send permissions.');
  console.log('You can also use /start command to manually activate notifications.');
  console.log(`Currently registered chats: ${notificationChats.size}`);
})();

process.on('unhandledRejection', console.error);
process.on('SIGINT', async () => { 
  await saveState(); 
  console.log('Bot stopped'); 
  process.exit(0); 
});
