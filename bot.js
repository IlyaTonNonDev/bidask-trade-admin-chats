// Telegram Bot: CA info + Модерация (mute/unmute) + Мониторинг покупок и продаж
require('dotenv').config({ path: './secretkeys.env' });
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs').promises;
const path = require('path');
const fetch = global.fetch; // В Node 18+ fetch встроен

// ==================== КОНФИГУРАЦИЯ ====================
const POLL_INTERVAL = 10000;
const POOL_DISCOVERY_INTERVAL = 60 * 60 * 1000;
const TON_ADDRESS = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TON_API_KEY = process.env.TON_API_KEY;
const PRICE_CACHE_TTL = 60 * 1000;

if (!TELEGRAM_BOT_TOKEN) {
  console.error('Error: TELEGRAM_BOT_TOKEN is not set');
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// ==================== ДОСТУП ====================
// /start разрешён любому администратору группы или пользователю в личном чате

// ==================== ХРАНЕНИЕ НАСТРОЕК ====================
const chatSettings = {}; // { chatId: { minBuyThreshold: 5 } }
const chatConfigs = {}; // { chatId: { tokenAddress, bidaskPool, stonfiPools:[], dedustPools:[], decimals, totalSupply, tokenImage, tokenName, tokenSymbol } }
const notificationChats = new Set();
const autoRegisteredChats = new Set(); // Чаты, автоматически зарегистрированные как админские

function ensureChatConfig(chatId) {
  if (!chatSettings[chatId]) chatSettings[chatId] = { minBuyThreshold: 5 };
  if (!chatConfigs[chatId]) {
    chatConfigs[chatId] = { stonfiPools: [], dedustPools: [], stonfiPoolsMeta: {}, dedustPoolsMeta: {} };
  }
  if (!chatConfigs[chatId].stonfiPoolsMeta) chatConfigs[chatId].stonfiPoolsMeta = {};
  if (!chatConfigs[chatId].dedustPoolsMeta) chatConfigs[chatId].dedustPoolsMeta = {};
}

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

function calculateMC(price, totalSupply) {
  if (!price || !totalSupply) return '???';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(price * totalSupply);
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
async function getTransactions(poolAddress) {
  try {
    if (!TON_API_KEY) {
      console.log('[1. GET_TRANSACTIONS] ❌ TON_API_KEY not set');
      return [];
    }
    console.log('[1. GET_TRANSACTIONS] 🔍 Fetching from TON API...');
    const resp = await fetch(`https://tonapi.io/v2/blockchain/accounts/${poolAddress}/transactions?limit=20`, {
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

async function getTokenPrice(tokenAddress) {
  try {
    if (!TON_API_KEY) return null;
    const response = await fetch(`https://tonapi.io/v2/rates?tokens=${tokenAddress}&currencies=usd`, {
      headers: { 'Authorization': `Bearer ${TON_API_KEY}`, 'Content-Type': 'application/json' }
    });
    if (!response.ok) throw new Error(`Rates API error: ${response.status}`);
    const data = await response.json();
    const direct = data.rates?.[tokenAddress]?.prices?.USD || null;
    if (direct) return direct;

    // Fallback: find matching key if TON API returns another address format
    const rates = data.rates || {};
    const matchingKey = Object.keys(rates).find((key) => addressesMatch(key, tokenAddress));
    if (matchingKey) {
      return rates[matchingKey]?.prices?.USD || null;
    }

    console.warn(`[getTokenPrice] No USD price for token ${tokenAddress}`);
    return null;
  } catch (error) { console.error('Error fetching price:', error.message); return null; }
}

function getCachedPrice(cfg) {
  if (!cfg?.lastPriceUsd || !cfg?.lastPriceTs) return null;
  if (Date.now() - cfg.lastPriceTs > PRICE_CACHE_TTL) return null;
  return cfg.lastPriceUsd;
}

function setCachedPrice(cfg, priceUsd, source) {
  if (!cfg) return;
  cfg.lastPriceUsd = priceUsd;
  cfg.lastPriceTs = Date.now();
  cfg.lastPriceSource = source;
}

function derivePriceUsdFromSwap(swap, tonUsdPrice) {
  if (!swap || !tonUsdPrice) return null;
  const tonValue = swap.tonValue;
  const tokenAmount = swap.tokenAmount;
  if (!tonValue || !tokenAmount || tokenAmount <= 0) return null;
  const priceUsd = (tonValue / tokenAmount) * tonUsdPrice;
  return Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : null;
}

async function getTokenPriceFromPools(cfg) {
  if (!cfg?.tokenAddress) return null;
  const tonUsd = await getTokenPrice(TON_ADDRESS);
  if (!tonUsd) return null;

  const pools = [
    cfg.bidaskPool,
    ...(cfg.stonfiPools || []),
    ...(cfg.dedustPools || [])
  ].filter(Boolean);
  if (pools.length === 0) return null;

  for (const pool of pools) {
    const dexHint =
      pool === cfg.bidaskPool ? 'bidask' :
      (cfg.stonfiPools || []).includes(pool) ? 'stonfi' :
      (cfg.dedustPools || []).includes(pool) ? 'dedust' :
      null;
    const poolMeta = (cfg.stonfiPoolsMeta && cfg.stonfiPoolsMeta[pool]) ? cfg.stonfiPoolsMeta[pool] : null;
    const transactions = await getTransactions(pool) || [];
    transactions.sort((a, b) => (b.utime || 0) - (a.utime || 0));

    for (const tx of transactions) {
      const opName = tx.in_msg?.decoded_op_name;
      const decodedBody = tx.in_msg?.decoded_body;
      let swap = null;
      if (decodedBody) {
        swap = parseSwapFromDecodedBody(decodedBody, 0, cfg.tokenAddress, cfg.decimals || 9, opName, dexHint, poolMeta);
      }
      if (!swap) {
        swap = parseSwapFromActions(tx, 0, cfg.tokenAddress, cfg.decimals || 9, dexHint);
      }
      const priceUsd = derivePriceUsdFromSwap(swap, tonUsd);
      if (priceUsd) return priceUsd;
    }
  }

  return null;
}

async function getTokenPriceWithFallback(chatId, cfg) {
  const cached = getCachedPrice(cfg);
  if (cached) return cached;

  const direct = await getTokenPrice(cfg.tokenAddress);
  if (direct) {
    setCachedPrice(cfg, direct, 'tonapi');
    return direct;
  }

  const derived = await getTokenPriceFromPools(cfg);
  if (derived) {
    setCachedPrice(cfg, derived, 'pool');
    return derived;
  }

  console.warn(`[getTokenPriceWithFallback] No price for chat ${chatId}, token ${cfg.tokenAddress}`);
  return null;
}

const tokenImageCache = new Map();
async function getTokenImage(tokenAddress) {
  if (tokenImageCache.has(tokenAddress)) return tokenImageCache.get(tokenAddress);
  if (!TON_API_KEY) return null;
  try {
    const resp = await fetch(`https://tonapi.io/v2/jettons/${tokenAddress}`, {
      headers: { 'Authorization': `Bearer ${TON_API_KEY}`, 'Content-Type': 'application/json' }
    });
    if (!resp.ok) throw new Error(`Jetton API error: ${resp.status}`);
    const data = await resp.json();
    const imageUrl = data.metadata?.image || data.preview || null;
    if (imageUrl) tokenImageCache.set(tokenAddress, imageUrl);
    return imageUrl;
  } catch (error) { console.error('Error fetching token logo:', error.message); return null; }
}

// Отправка сообщения с картинкой токена, если есть
async function sendWithImage(chatId, text, tokenAddress, tokenImageOverride, extraOpts = {}) {
  const opts = { parse_mode: 'HTML', disable_web_page_preview: true, ...extraOpts };
  try {
    const img = tokenImageOverride || await getTokenImage(tokenAddress);
    if (img) {
      await bot.sendPhoto(chatId, img, { caption: text, ...opts });
    } else {
      await bot.sendMessage(chatId, text, opts);
    }
  } catch (err) {
    console.error('[sendWithImage] Error:', err.message);
    await bot.sendMessage(chatId, text, opts);
  }
}

async function fetchJettonInfo(tokenAddress) {
  if (!TON_API_KEY) return null;
  const url = `https://tonapi.io/v2/jettons/${tokenAddress}`;
  try {
    const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${TON_API_KEY}`, 'Content-Type': 'application/json' } });
    if (!resp.ok) throw new Error(`Jetton API error: ${resp.status}`);
    const data = await resp.json();
    const decimals = parseInt(data.metadata?.decimals || '9', 10);
    const supplyRaw = data.total_supply ? parseInt(data.total_supply) : null;
    return {
      decimals,
      totalSupply: supplyRaw !== null ? supplyRaw / Math.pow(10, decimals) : null,
      image: data.metadata?.image || data.preview || null,
      name: data.metadata?.name || '',
      symbol: data.metadata?.symbol || ''
    };
  } catch (err) {
    console.error(`[fetchJettonInfo] Error: ${err.message}`);
    return null;
  }
}

async function fetchStonfiPools(tokenAddress) {
  try {
    const url = `https://api.ston.fi/v1/pools?jetton_address=${tokenAddress}`;
    const resp = await fetch(url);
    const data = await resp.json();
    const pools = data?.pool_list || [];
    return pools
      .filter(p => tokenAddress === p.token0_address || tokenAddress === p.token1_address)
      .map(p => ({
        address: p.address,
        token0_address: p.token0_address,
        token1_address: p.token1_address
      }));
  } catch (error) {
    console.error(`[fetchStonfiPools] Error: ${error.message}`);
    return [];
  }
}

async function fetchDedustPools(tokenAddress) {
  try {
    const url = `https://api.dedust.io/v2/pools?asset=jetton:${tokenAddress}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!Array.isArray(data)) return [];
    return data
      .filter(p => Array.isArray(p.assets) && p.assets.some(a => a?.address === tokenAddress))
      .map(p => p.address);
  } catch (error) {
    console.error(`[fetchDedustPools] Error: ${error.message}`);
    return [];
  }
}

// ==================== ПАРСИНГ ТРАНЗАКЦИЙ ====================
function extractAddressField(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return value.address || value.account?.address || value.wallet?.address || null;
  return null;
}

function extractBigInt(value) {
  try {
    if (value === null || value === undefined) return null;
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
    if (typeof value === 'string') {
      const s = value.trim();
      if (/^\d+$/.test(s)) return BigInt(s);
    }
    if (typeof value === 'object') {
      // некоторые ответы могут заворачивать числа в { value: "..." }
      if (value.value !== undefined) return extractBigInt(value.value);
      if (value.amount !== undefined) return extractBigInt(value.amount);
    }
    return null;
  } catch {
    return null;
  }
}

function nanoToTon(nano) {
  const bi = extractBigInt(nano);
  if (bi === null) return null;
  // для уведомлений достаточно Number; TON суммы обычно безопасны по диапазону
  return Number(bi) / 1e9;
}

function unitsToNumber(raw, decimals) {
  const bi = extractBigInt(raw);
  if (bi === null) return null;
  const div = Math.pow(10, decimals || 9);
  return Number(bi) / div;
}

function detectAsset(asset) {
  if (!asset) return { isTon: false, address: null };
  if (typeof asset === 'string') {
    const lower = asset.toLowerCase();
    if (lower === 'ton' || lower === 'native' || lower === 'nanoton') return { isTon: true, address: null };
    return { isTon: false, address: asset };
  }
  if (typeof asset === 'object') {
    const type = (asset.type || asset.kind || asset.asset_type || '').toString().toLowerCase();
    if (type === 'ton' || type === 'native') return { isTon: true, address: null };
    if (asset.is_native === true || asset.isTon === true) return { isTon: true, address: null };
    const addr =
      extractAddressField(asset.address) ||
      extractAddressField(asset.jetton) ||
      extractAddressField(asset.token) ||
      extractAddressField(asset.master) ||
      extractAddressField(asset.jetton_master) ||
      extractAddressField(asset.wallet) ||
      extractAddressField(asset);
    return { isTon: false, address: addr || null };
  }
  return { isTon: false, address: null };
}

function safeJson(obj, limit = 2000) {
  try {
    const str = JSON.stringify(obj);
    return str.length > limit ? `${str.slice(0, limit)}...` : str;
  } catch {
    return '[unserializable]';
  }
}

function isTonAddress(address) {
  if (!address) return false;
  return normalizeAddress(address) === normalizeAddress(TON_ADDRESS);
}

function parseSwapFromActions(tx, minThreshold, tokenAddress, tokenDecimals, dexHint) {
  try {
    const actions = Array.isArray(tx.actions) ? tx.actions : [];
    if (actions.length === 0) return null;

    const tokenNorm = normalizeAddress(tokenAddress);

    for (const action of actions) {
      if (!action || typeof action !== 'object') continue;

      // Кандидат на swap: либо type JettonSwap, либо поле JettonSwap, либо любое поле с "swap" в имени
      let swapObj = null;
      if (action.JettonSwap && typeof action.JettonSwap === 'object') swapObj = action.JettonSwap;
      if (!swapObj && action.type === 'JettonSwap') swapObj = action;
      if (!swapObj) {
        const key = Object.keys(action).find(k => k.toLowerCase().includes('swap') && typeof action[k] === 'object');
        if (key) swapObj = action[key];
      }
      if (!swapObj || typeof swapObj !== 'object') continue;

      const jettonIn = extractAddressField(swapObj.jetton_in) ||
                       extractAddressField(swapObj.jettonIn) ||
                       extractAddressField(swapObj.asset_in) ||
                       extractAddressField(swapObj.assetIn) ||
                       extractAddressField(swapObj.token_in) ||
                       extractAddressField(swapObj.tokenIn) ||
                       extractAddressField(swapObj.jetton_master_in) ||
                       extractAddressField(swapObj.jettonMasterIn);

      const jettonOut = extractAddressField(swapObj.jetton_out) ||
                        extractAddressField(swapObj.jettonOut) ||
                        extractAddressField(swapObj.asset_out) ||
                        extractAddressField(swapObj.assetOut) ||
                        extractAddressField(swapObj.token_out) ||
                        extractAddressField(swapObj.tokenOut) ||
                        extractAddressField(swapObj.jetton_master_out) ||
                        extractAddressField(swapObj.jettonMasterOut);

      const tonIn = nanoToTon(swapObj.ton_in ?? swapObj.tonIn ?? swapObj.native_in ?? swapObj.nativeIn ?? swapObj.in_ton ?? swapObj.inTon);
      const tonOut = nanoToTon(swapObj.ton_out ?? swapObj.tonOut ?? swapObj.native_out ?? swapObj.nativeOut ?? swapObj.out_ton ?? swapObj.outTon);

      const amountIn = extractBigInt(swapObj.amount_in ?? swapObj.amountIn ?? swapObj.in_amount ?? swapObj.inAmount ?? swapObj.offer_amount ?? swapObj.offerAmount);
      const amountOut = extractBigInt(swapObj.amount_out ?? swapObj.amountOut ?? swapObj.out_amount ?? swapObj.outAmount ?? swapObj.ask_amount ?? swapObj.askAmount);

      const jettonInNorm = jettonIn ? normalizeAddress(jettonIn) : null;
      const jettonOutNorm = jettonOut ? normalizeAddress(jettonOut) : null;

      const involvesToken = !!(tokenNorm && (tokenNorm === jettonInNorm || tokenNorm === jettonOutNorm));
      if (!involvesToken) continue;

      // BUY: TON -> token ; SELL: token -> TON
      if (tonIn !== null && tonIn !== undefined && jettonOutNorm && tokenNorm === jettonOutNorm) {
        const tokenAmount = amountOut ? unitsToNumber(amountOut, tokenDecimals) : null;
        const tonValue = tonIn;
        if (tonValue < minThreshold) continue;
        return {
          volume: tonValue,
          tonValue,
          tokenAmount,
          from: extractAddressField(swapObj.user) || extractAddressField(swapObj.sender) || tx.in_msg?.source?.address || 'Unknown',
          to: tx.in_msg?.destination?.address || 'Unknown',
          type: 'BUY',
          dex: dexHint || swapObj.dex || swapObj.platform || swapObj.exchange || null,
          hash: tx.hash || '',
          timestamp: tx.utime || 0
        };
      }

      if (tonOut !== null && tonOut !== undefined && jettonInNorm && tokenNorm === jettonInNorm) {
        const tokenAmount = amountIn ? unitsToNumber(amountIn, tokenDecimals) : null;
        const tonValue = tonOut;
        if (tonValue < minThreshold) continue;
        return {
          // для SELL отображаем количество токенов (как и раньше для Bidask)
          volume: tokenAmount ?? 0,
          tonValue,
          tokenAmount,
          from: extractAddressField(swapObj.user) || extractAddressField(swapObj.sender) || tx.in_msg?.source?.address || 'Unknown',
          to: tx.in_msg?.destination?.address || 'Unknown',
          type: 'SELL',
          dex: dexHint || swapObj.dex || swapObj.platform || swapObj.exchange || null,
          hash: tx.hash || '',
          timestamp: tx.utime || 0
        };
      }
    }

    return null;
  } catch (error) {
    console.error('[parseSwapFromActions] Error:', error.message);
      return null;
    }
}

function parseSwapFromDecodedBody(decodedBody, minThreshold, tokenAddress, tokenDecimals, opName, dexHint, poolMeta) {
  try {
    // Специальный разбор stonfi_swap_v2: left/right_amount + swap_body.min_out
    if (opName && opName.toLowerCase().includes('stonfi_swap') && decodedBody) {
      const leftAmount = extractBigInt(decodedBody.left_amount);
      const rightAmount = extractBigInt(decodedBody.right_amount);
      const minOut = extractBigInt(decodedBody.dex_payload?.swap_body?.min_out);
      const fromUser = decodedBody.from_user || decodedBody.dex_payload?.swap_body?.receiver;

      const token0 = poolMeta?.token0 || null;
      const token1 = poolMeta?.token1 || null;

      const token0IsTon = isTonAddress(token0);
      const token1IsTon = isTonAddress(token1);

      // Считаем, что left_amount относится к token0, right_amount к token1
      if (token1IsTon && token0) {
        if (rightAmount && rightAmount > 0n) {
          // BUY: TON -> token0
          const tonValue = nanoToTon(rightAmount);
          if (tonValue !== null && tonValue >= minThreshold) {
            const tokenAmount = minOut ? unitsToNumber(minOut, tokenDecimals) : null;
            return {
              volume: tonValue,
              tonValue,
              tokenAmount,
              from: fromUser || 'Unknown',
              to: 'Unknown',
              type: 'BUY',
              dex: dexHint || opName || null,
              hash: '',
              timestamp: 0
            };
          }
        }
        if (leftAmount && leftAmount > 0n) {
          // SELL: token0 -> TON, tonValue ≈ min_out
          const tonValue = minOut ? nanoToTon(minOut) : null;
          if (tonValue !== null && tonValue >= minThreshold) {
            const tokenAmount = unitsToNumber(leftAmount, tokenDecimals);
            return {
              volume: tokenAmount ?? 0,
              tonValue,
              tokenAmount,
              from: fromUser || 'Unknown',
              to: 'Unknown',
              type: 'SELL',
              dex: dexHint || opName || null,
              hash: '',
              timestamp: 0
            };
          }
        }
      }

      if (token0IsTon && token1) {
        if (leftAmount && leftAmount > 0n) {
          const tonValue = nanoToTon(leftAmount);
          if (tonValue !== null && tonValue >= minThreshold) {
            const tokenAmount = minOut ? unitsToNumber(minOut, tokenDecimals) : null;
            return {
              volume: tonValue,
              tonValue,
              tokenAmount,
              from: fromUser || 'Unknown',
              to: 'Unknown',
              type: 'BUY',
              dex: dexHint || opName || null,
              hash: '',
              timestamp: 0
            };
          }
        }
        if (rightAmount && rightAmount > 0n) {
          const tonValue = minOut ? nanoToTon(minOut) : null;
          if (tonValue !== null && tonValue >= minThreshold) {
            const tokenAmount = unitsToNumber(rightAmount, tokenDecimals);
            return {
              volume: tokenAmount ?? 0,
              tonValue,
              tokenAmount,
              from: fromUser || 'Unknown',
              to: 'Unknown',
              type: 'SELL',
              dex: dexHint || opName || null,
              hash: '',
              timestamp: 0
            };
          }
        }
      }
    }

    const candidates = [
      decodedBody,
      decodedBody.swap,
      decodedBody.params,
      decodedBody.swap_body,
      decodedBody.swapBody,
      decodedBody.data
    ].filter(obj => obj && typeof obj === 'object');

    const tokenNorm = normalizeAddress(tokenAddress);

    for (const body of candidates) {
      const assetInRaw =
        body.asset_in || body.assetIn ||
        body.offer_asset || body.offerAsset ||
        body.token_in || body.tokenIn ||
        body.jetton_in || body.jettonIn ||
        body.from_asset || body.fromAsset ||
        body.from_token || body.fromToken;

      const assetOutRaw =
        body.asset_out || body.assetOut ||
        body.ask_asset || body.askAsset ||
        body.token_out || body.tokenOut ||
        body.jetton_out || body.jettonOut ||
        body.to_asset || body.toAsset ||
        body.to_token || body.toToken;

      const assetIn = detectAsset(assetInRaw);
      const assetOut = detectAsset(assetOutRaw);

      const amountIn =
        extractBigInt(body.amount_in ?? body.amountIn ?? body.in_amount ?? body.inAmount ?? body.offer_amount ?? body.offerAmount ?? body.amount);
      const amountOut =
        extractBigInt(body.amount_out ?? body.amountOut ?? body.out_amount ?? body.outAmount ?? body.ask_amount ?? body.askAmount ?? body.min_amount_out ?? body.minAmountOut);

      const jettonInNorm = assetIn.address ? normalizeAddress(assetIn.address) : null;
      const jettonOutNorm = assetOut.address ? normalizeAddress(assetOut.address) : null;

      const involvesToken = !!(tokenNorm && (tokenNorm === jettonInNorm || tokenNorm === jettonOutNorm));
      if (!involvesToken) continue;

      // BUY: TON -> token
      if (assetIn.isTon && jettonOutNorm && tokenNorm === jettonOutNorm && amountIn !== null) {
        const tonValue = nanoToTon(amountIn);
        if (tonValue === null) continue;
        if (tonValue < minThreshold) continue;
        const tokenAmount = amountOut ? unitsToNumber(amountOut, tokenDecimals) : null;
        return {
          volume: tonValue,
          tonValue,
          tokenAmount,
          from: extractAddressField(body.user) || extractAddressField(body.sender) || extractAddressField(decodedBody.sender) || 'Unknown',
          to: extractAddressField(body.receiver) || extractAddressField(body.to) || 'Unknown',
          type: 'BUY',
          dex: dexHint || opName || null,
          hash: '',
          timestamp: 0
        };
      }

      // SELL: token -> TON
      if (assetOut.isTon && jettonInNorm && tokenNorm === jettonInNorm && amountOut !== null) {
        const tonValue = nanoToTon(amountOut);
        if (tonValue === null) continue;
        if (tonValue < minThreshold) continue;
        const tokenAmount = amountIn ? unitsToNumber(amountIn, tokenDecimals) : null;
        return {
          volume: tokenAmount ?? 0,
          tonValue,
          tokenAmount,
          from: extractAddressField(body.user) || extractAddressField(body.sender) || extractAddressField(decodedBody.sender) || 'Unknown',
          to: extractAddressField(body.receiver) || extractAddressField(body.to) || 'Unknown',
          type: 'SELL',
          dex: dexHint || opName || null,
          hash: '',
          timestamp: 0
        };
      }
    }

    if (opName && opName.toLowerCase().includes('stonfi')) {
      console.log(`[parseSwapFromDecodedBody] Stonfi body keys: ${Object.keys(decodedBody || {}).join(', ')}`);
      console.log(`[parseSwapFromDecodedBody] Stonfi body: ${safeJson(decodedBody)}`);
    }
    return null;
  } catch (error) {
    console.error('[parseSwapFromDecodedBody] Error:', error.message);
    return null;
  }
}

function parseTransaction(tx, minThreshold, tokenPrice, tokenAddress, tokenDecimals = 9, dexHint = null, poolMeta = null) {
  try {
    const txHash = tx.hash || 'unknown';
    console.log(`[2. PARSE_TRANSACTION] 🔍 Parsing tx: ${txHash.substring(0, 8)}...`);

    const opName = tx.in_msg?.decoded_op_name;
    const decodedBody = tx.in_msg?.decoded_body;
    console.log(`[2. PARSE_TRANSACTION] 📋 Op name: ${opName}, has decodedBody: ${!!decodedBody}`);
    
    // Поддерживаем bidask_damm_swap (покупки), jetton_transfer и jetton_notify (продажи на стороне пула)
    if ((opName !== 'bidask_damm_swap' && opName !== 'jetton_transfer' && opName !== 'jetton_notify') || !decodedBody) {
      if (decodedBody) {
        const decodedParsed = parseSwapFromDecodedBody(decodedBody, minThreshold, tokenAddress, tokenDecimals, opName, dexHint, poolMeta);
        if (decodedParsed) {
          decodedParsed.hash = tx.hash || '';
          decodedParsed.timestamp = tx.utime || 0;
          console.log(`[2. PARSE_TRANSACTION] ✅ Parsed via decodedBody (swap): ${decodedParsed.type} ${decodedParsed.tonValue} TON`);
          return decodedParsed;
        }
      }
      // Для Ston.fi / DeDust часто проще и надежнее брать нормализованный swap из tx.actions (TON API)
      const actionParsed = parseSwapFromActions(tx, minThreshold, tokenAddress, tokenDecimals, dexHint);
      if (actionParsed) {
        console.log(`[2. PARSE_TRANSACTION] ✅ Parsed via actions (swap): ${actionParsed.type} ${actionParsed.tonValue} TON`);
        return actionParsed;
      }
      console.log(`[2. PARSE_TRANSACTION] ❌ Not a supported Bidask op and no swap action found`);
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
        tonValue: value,
        tokenAmount: null,
        from, 
        to, 
        type, 
        dex: dexHint || 'bidask',
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
      const tokenAddressNormalized = normalizeAddress(tokenAddress);
      const jettonAddressNormalized = normalizeAddress(jettonAddress);
      jettonMatches = jettonAddress === tokenAddress || 
                      (tokenAddressNormalized && jettonAddressNormalized && tokenAddressNormalized === jettonAddressNormalized);
      console.log(`[2. PARSE_TRANSACTION] 🔍 Jetton comparison: jetton=${jettonAddress?.substring(0, 20) || 'none'}..., TOKEN_ADDRESS=${tokenAddress.substring(0, 20)}..., matches=${jettonMatches}`);
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
      tonValue: type === 'SELL' ? value : value,
      tokenAmount: type === 'SELL' ? tondevAmount : null,
      from, 
      to, 
      type, 
      dex: dexHint || 'bidask',
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
async function sendNotification(chatId, txData, price, tokenAddress, tokenImageOverride, bidaskPool) {
  console.log(`[4. SEND_NOTIFICATION] 📤 Sending notification for tx: ${txData.hash.substring(0, 8)}..., type: ${txData.type}, chatId: ${chatId}`);
  const buyerInfo = await formatAddress(txData.from);
  const buyerDisplay = buyerInfo.display.length > 20 ? buyerInfo.display.substring(0, 17) + '...' : buyerInfo.display;
  const mc = calculateMC(price, txData.totalSupply || null);
  const dexLabel = (txData.dex || 'DEX').toString().toUpperCase();

  let caption;
  if (txData.type === 'BUY') {
    const tonValue = txData.tonValue ?? txData.volume;
    const emoji = getRocketString(tonValue);
    const tokenLine = (txData.tokenAmount !== null && txData.tokenAmount !== undefined)
      ? `\n🪙 Received: <b>${formatNumber(txData.tokenAmount)} ${txData.tokenSymbol || 'TOKEN'}</b>`
      : '';
    caption = `<b>NEW BUY!</b> ${emoji}\n\n💎 <b>${formatNumber(tonValue)} TON</b>${tokenLine}\n🦑 <a href="https://tonviewer.com/${buyerInfo.link}">${buyerDisplay}</a> | <a href="https://tonviewer.com/transaction/${txData.hash}">Txn</a>\n🌐 MC: ${mc}\n🏪 DEX: <b>${dexLabel}</b>`;
  } else {
    const symbol = txData.tokenSymbol || 'TOKEN';
    const tokenAmount = txData.tokenAmount ?? txData.volume;
    const emoji = getHeartString(txData.tonValue ?? 1);
    const mainLine = tokenAmount ? `🤬 <b>${formatNumber(tokenAmount)} ${symbol}</b>` : `🤬 <b>SELL</b>`;
    caption = `<b>NEW SELL!</b> ${emoji}\n\n${mainLine}\n🦑 <a href="https://tonviewer.com/${buyerInfo.link}">${buyerDisplay}</a> | <a href="https://tonviewer.com/transaction/${txData.hash}">Txn</a>\n🌐 MC: ${mc}\n🏪 DEX: <b>${dexLabel}</b>`;
  }

  const keyboard = {
    inline_keyboard: [
      [
        { text: 'DTRADE', url: `https://t.me/dtrade?start=26RoWqxLlD_${tokenAddress}` },
        { text: 'Graph', url: `https://x1000.finance/tokens/${tokenAddress}?ref=nextmayor` }
      ]
    ]
  };

  if (bidaskPool) {
    keyboard.inline_keyboard.push([
      { text: '🔥 TRADE ON BIDASK', url: `https://bidask.finance/en/app/pools/${bidaskPool}?utm_campaign=buybot` }
    ]);
  }

  try {
    const tokenImage = tokenImageOverride || await getTokenImage(tokenAddress);
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
const lastProcessedTimestamp = new Map(); // key: `${chatId}:${pool}` -> ts
const lastPoolDiscovery = new Map(); // key chatId -> timestamp

function getLastTs(chatId, pool) {
  return lastProcessedTimestamp.get(`${chatId}:${pool}`) || (Math.floor(Date.now() / 1000) - 600);
}
function setLastTs(chatId, pool, ts) {
  lastProcessedTimestamp.set(`${chatId}:${pool}`, ts);
}

function shouldDiscover(chatId) {
  const last = lastPoolDiscovery.get(chatId) || 0;
  return Date.now() - last > POOL_DISCOVERY_INTERVAL;
}

async function refreshPoolsForChat(chatId, force = false) {
  const cfg = chatConfigs[chatId];
  if (!cfg || !cfg.tokenAddress) return;
  if (!force && !shouldDiscover(chatId)) return;
  const stonfi = await fetchStonfiPools(cfg.tokenAddress);
  const dedust = await fetchDedustPools(cfg.tokenAddress);
  cfg.stonfiPools = stonfi.map(p => p.address);
  cfg.stonfiPoolsMeta = stonfi.reduce((acc, p) => {
    acc[p.address] = { token0: p.token0_address, token1: p.token1_address };
    return acc;
  }, {});
  cfg.dedustPools = dedust;
  lastPoolDiscovery.set(chatId, Date.now());
  await saveState();
  console.log(`[DISCOVERY] Updated pools for ${chatId}: stonfi=${stonfi.length}, dedust=${dedust.length}`);
}

async function monitorTransactions() {
  try {
    if (!TON_API_KEY) {
      console.log('[MONITOR] ❌ TON_API_KEY not set, skipping');
      return;
    }
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

      const cfg = chatConfigs[chatId];
      if (!cfg || !cfg.tokenAddress) {
        console.log(`[MONITOR] ⚠️ Chat ${chatId} has no token configured`);
        continue;
      }

      await refreshPoolsForChat(chatId);

      const pools = [
        cfg.bidaskPool,
        ...(cfg.stonfiPools || []),
        ...(cfg.dedustPools || [])
      ].filter(Boolean);

      if (pools.length === 0) {
        console.log(`[MONITOR] ⚠️ Chat ${chatId} has no pools configured`);
        continue;
      }

      const price = await getTokenPriceWithFallback(chatId, cfg);
      
      const minThreshold = chatSettings[chatId]?.minBuyThreshold || 5;
      console.log(`[MONITOR] 💬 Processing chat ${chatId} with threshold ${minThreshold} TON, pools=${pools.length}`);

      for (const pool of pools) {
        const dexHint =
          pool === cfg.bidaskPool ? 'bidask' :
          (cfg.stonfiPools || []).includes(pool) ? 'stonfi' :
          (cfg.dedustPools || []).includes(pool) ? 'dedust' :
          null;
        const poolMeta = (cfg.stonfiPoolsMeta && cfg.stonfiPoolsMeta[pool]) ? cfg.stonfiPoolsMeta[pool] : null;
        const transactions = await getTransactions(pool) || [];
        // Обрабатываем в порядке возрастания времени, чтобы не пропускать более ранние tx,
        // если встретили позднюю и обновили lastTs
        transactions.sort((a, b) => (a.utime || 0) - (b.utime || 0));
        console.log(`[MONITOR] 📊 Pool ${pool} has ${transactions.length} txs, lastTs=${getLastTs(chatId, pool)}`);

        let processedCount = 0;
        let skippedOldCount = 0;

        const newTxs = transactions.filter(tx => tx.utime > getLastTs(chatId, pool));
        if (newTxs.length > 0) {
          const firstNewTx = newTxs[0];
          console.log(`[MONITOR] 🔬 Debug first new tx structure for pool ${pool}:`, JSON.stringify({
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

          if (tx.utime <= getLastTs(chatId, pool)) {
            skippedOldCount++;
            continue;
          }

          const txData = parseTransaction(tx, minThreshold, price, cfg.tokenAddress, cfg.decimals || 9, dexHint, poolMeta);
          if (txData) {
            txData.totalSupply = cfg.totalSupply;
            txData.tokenSymbol = cfg.tokenSymbol;
            await sendNotification(chatId, txData, price, cfg.tokenAddress, cfg.tokenImage, cfg.bidaskPool);
            if (txData.timestamp > getLastTs(chatId, pool)) {
              setLastTs(chatId, pool, txData.timestamp);
            }
            processedCount++;
          }
        }

        console.log(`[MONITOR] 📈 Summary for chat ${chatId}, pool ${pool}: processed=${processedCount}, skipped_old=${skippedOldCount}, total=${transactions.length}`);
      }
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
      chatSettings: chatSettings,
      chatConfigs: chatConfigs
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

    if (state.chatConfigs && typeof state.chatConfigs === 'object') {
      Object.assign(chatConfigs, state.chatConfigs);
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
      const welcomeText = [
        'Я отслеживаю покупки/продажи токена на Bidask, STON.fi и DeDust.',
        '/settoken &lt;CA&gt; — указать токен',
        '/setpool &lt;адрес&gt; — указать пул Bidask'
      ].join('\n');
      await bot.sendMessage(chatId, welcomeText, { parse_mode: 'HTML' });
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
    // Access control: в группах — только админы, в личке — разрешаем
    if (chatId < 0 && !(await isAdmin(chatId, userId))) {
        console.log(`[/START] ❌ Access denied for user ${userId}`);
        try {
            await bot.sendMessage(
                chatId,
            "⛔ Эта команда доступна только администраторам чата."
        );
            console.log(`[/START] ✅ Denied message sent to chat ${chatId}`);
        } catch (error) {
            console.error(`[/START] ❌ Error sending denied message:`, error.message);
        }
        return;
    }

    console.log(`[/START] ✅ Access granted for user ${userId}`);
    ensureChatConfig(chatId);

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
        await bot.sendMessage(chatId, "⚠️ Уведомления работают только в группах. Добавьте бота в группу как администратора и используйте там /settoken и /setpool.", { parse_mode: 'HTML' });
        return;
    }
    const settings = chatSettings[chatId];
    const cfg = chatConfigs[chatId];

    if (!cfg.tokenAddress) {
        await bot.sendMessage(chatId, "Токен не настроен. Используйте /settoken &lt;CA&gt; в этом чате.", { parse_mode: 'HTML' });
        return;
    }

    const message = `
🏴 <b>Token Info</b>
🔹 Name: <b>${cfg.tokenName || cfg.tokenSymbol || 'N/A'}</b>
🔹 CA: <code>${cfg.tokenAddress}</code>
🔹 Minimum buy threshold: <b>${settings.minBuyThreshold} TON</b>
🔹 Notifications for this chat: <b>${chatId < 0 && notificationChats.has(chatId) ? 'ON' : 'OFF'}</b>${chatId > 0 ? '\n\n⚠️ Уведомления работают только в группах' : ''}
🔹 Bidask pool: <code>${cfg.bidaskPool || 'не задан'}</code>
🔹 Stonfi pools: ${cfg.stonfiPools?.length || 0}
🔹 DeDust pools: ${cfg.dedustPools?.length || 0}
`;

    try {
        await sendWithImage(chatId, message, cfg.tokenAddress, cfg.tokenImage);
        console.log(`[/START] ✅ Start message sent successfully to chat ${chatId}`);
    } catch (error) {
        console.error(`[/START] ❌ Error sending /start message:`, error.message);
        console.error(error.stack);
    }
});

// ==================== КОМАНДА /CA ====================
bot.onText(/\/ca$/i, async (msg) => {
    const chatId = msg.chat.id;
    const cfg = chatConfigs[chatId];
    if (!cfg?.tokenAddress) {
        return bot.sendMessage(chatId, "Токен не настроен. Укажите CA через /settoken.", { parse_mode: 'HTML' });
    }

    const message = `🏴 <b>Contract Address</b>\n\n<code>${cfg.tokenAddress}</code>\n\n💸 <a href="https://t.me/dtrade?start=26RoWqxLlD_${cfg.tokenAddress}">Trade on @dtrade</a>\n🏴 <a href="https://bidask.finance/en/app/swap/ton/${cfg.tokenAddress}">Swap on Bidask</a>`;
    
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

    if (chatId > 0) {
        return bot.sendMessage(chatId, "⚠️ Эта команда доступна только в группах. Добавьте бота в группу и используйте команду там.");
    }
    if (!(await isAdmin(chatId, userId))) {
        return bot.sendMessage(chatId, "⛔ Эта команда доступна только администраторам чата.");
    }

    const settings = chatSettings[chatId] || { minBuyThreshold: 5 };
    const cfg = chatConfigs[chatId];
    if (!cfg?.tokenAddress) {
        return bot.sendMessage(chatId, "Токен не настроен. Укажите CA через /settoken.", { parse_mode: 'HTML' });
    }
    const isMonitoring = notificationChats.has(chatId);
    const price = await getTokenPriceWithFallback(chatId, cfg);
    const mc = calculateMC(price, cfg.totalSupply);

    const message = `📊 <b>Bot Status</b>\n\n` +
        `🔹 Notifications: <b>${isMonitoring ? 'ON' : 'OFF'}</b>\n` +
        `🔹 Minimum threshold: <b>${settings.minBuyThreshold} TON</b>\n` +
        `🔹 Token price: <b>$${price ? price.toFixed(8) : 'N/A'}</b>\n` +
        `🔹 Market Cap: <b>${mc}</b>\n` +
        `🔹 Token: <b>${cfg.tokenName || cfg.tokenSymbol || 'N/A'}</b>\n` +
        `🔹 CA: <code>${cfg.tokenAddress}</code>\n` +
        `🔹 Bidask pool: <code>${cfg.bidaskPool || 'не задан'}</code>\n` +
        `🔹 Stonfi pools: ${cfg.stonfiPools?.length || 0}\n` +
        `🔹 DeDust pools: ${cfg.dedustPools?.length || 0}\n` +
        `🔹 Monitoring interval: <b>${POLL_INTERVAL / 1000}s</b>`;

    try {
        await sendWithImage(chatId, message, cfg.tokenAddress, cfg.tokenImage);
    } catch (error) {
        console.error(`[/STATUS] Error:`, error.message);
    }
});

// ==================== КОМАНДА /VOLUME ====================
bot.onText(/\/volume(?:\s+(\d+(?:\.\d+)?))?/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (chatId > 0) {
        return bot.sendMessage(chatId, "⚠️ Эта команда доступна только в группах. Добавьте бота в группу и используйте команду там.");
    }
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

bot.onText(/\/settoken(?:@\w+)?(?:\s+(\S+))?/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    console.log(`[/SETTOKEN] 🔔 Command received from user ${userId} in chat ${chatId}: ${msg.text}`);
    if (chatId > 0) {
        return bot.sendMessage(chatId, "⚠️ Настройка токена доступна только в группах. Добавьте бота в группу и используйте команду там.");
    }
    if (!(await isAdmin(chatId, userId))) {
        return bot.sendMessage(chatId, "⛔ Эта команда доступна только администраторам чата.");
    }
    ensureChatConfig(chatId);
    const text = (msg.text || '').trim();
    const ca = text.replace(/^\/settoken(@\w+)?\s+/i, '').trim();
    if (!ca) {
        return bot.sendMessage(chatId, "❌ Укажите адрес токена. Формат: /settoken CA");
    }
    try {
        const info = await fetchJettonInfo(ca);
        chatConfigs[chatId].tokenAddress = ca;
        chatConfigs[chatId].decimals = info?.decimals ?? chatConfigs[chatId].decimals ?? 9;
        chatConfigs[chatId].totalSupply = info?.totalSupply ?? chatConfigs[chatId].totalSupply ?? null;
        chatConfigs[chatId].tokenImage = info?.image ?? chatConfigs[chatId].tokenImage ?? null;
        chatConfigs[chatId].tokenName = info?.name ?? chatConfigs[chatId].tokenName ?? '';
        chatConfigs[chatId].tokenSymbol = info?.symbol ?? chatConfigs[chatId].tokenSymbol ?? '';
        // Сброс пулов для обновления
        chatConfigs[chatId].stonfiPools = [];
        chatConfigs[chatId].dedustPools = [];
        await refreshPoolsForChat(chatId, true);
        await saveState();
        const infoLabel = info ? (info.name || info.symbol || ca) : ca;
        const note = info ? '' : '\n⚠️ Не удалось получить метаданные токена (проверьте CA и TON_API_KEY).';
        await bot.sendMessage(
          chatId,
          `✅ Токен обновлён: ${infoLabel}\nStonfi пулов: ${chatConfigs[chatId].stonfiPools.length}\nDeDust пулов: ${chatConfigs[chatId].dedustPools.length}${note}\nУкажите адрес пула Bidask через /setpool &lt;адрес&gt;`,
          { parse_mode: 'HTML' }
        );
    } catch (error) {
        console.error(`[/SETTOKEN] Error:`, error.message);
        await bot.sendMessage(chatId, `❌ Ошибка при установке токена: ${error.message}`);
    }
});

bot.onText(/\/setpool(?:@\w+)?(?:\s+(\S+))?/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    console.log(`[/SETPOOL] 🔔 Command received from user ${userId} in chat ${chatId}: ${msg.text}`);
    if (chatId > 0) {
        return bot.sendMessage(chatId, "⚠️ Настройка пула доступна только в группах. Добавьте бота в группу и используйте команду там.");
    }
    if (!(await isAdmin(chatId, userId))) {
        return bot.sendMessage(chatId, "⛔ Эта команда доступна только администраторам чата.");
    }
    ensureChatConfig(chatId);
    const text = (msg.text || '').trim();
    const pool = text.replace(/^\/setpool(@\w+)?\s+/i, '').trim();
    if (!pool) {
        return bot.sendMessage(chatId, "❌ Укажите адрес пула. Формат: /setpool &lt;адрес&gt;");
    }
    chatConfigs[chatId].bidaskPool = pool;
    await saveState();
    await bot.sendMessage(chatId, `✅ Адрес пула Bidask обновлён: ${pool}`);
});

// ==================== КОМАНДА /HELP ====================
bot.onText(/\/help$/i, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!(await isAdmin(chatId, userId))) {
        return bot.sendMessage(chatId, "⛔ Эта команда доступна только администраторам чата.");
    }

    const message = [
        '🤖 <b>Что делает бот</b>',
        'Отслеживает покупки и продажи токена в пулах Bidask, STON.fi и DeDust и присылает уведомления при превышении порога.',
        '',
        '📖 <b>Команды</b>',
        '/start - Активировать бота и показать информацию о токене',
        '/settoken &lt;CA&gt; - Установить адрес токена (только с аргументом)',
        '/setpool &lt;адрес&gt; - Установить адрес пула Bidask (только с аргументом)',
        '/ca - Показать адрес контракта (CA)',
        '/status - Показать статус бота',
        '/volume [число] - Показать/изменить минимальный порог (по умолчанию 5 TON)',
        '/mute [время] - Заглушить пользователя (ответьте на сообщение)',
        '/unmute - Разглушить пользователя (ответьте на сообщение)',
        '/help - Показать эту справку',
        '',
        '⚠️ Настройка токена и пула работает только через команды с аргументами.'
    ].join('\n');

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
    const userId = msg.from.id;
    if (msg.text && msg.text.startsWith('/')) {
        console.log(`[MESSAGE] 📩 Command message in chat ${chatId} from ${userId}: ${msg.text}`);
    }
    if (chatId > 0) {
        return;
    }

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
