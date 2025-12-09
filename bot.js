// Объединённый Telegram Bot
// Функционал: CA info + Модерация (mute/unmute) + Мониторинг покупок
// Для запуска на bothost.ru или другом хостинге

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

if (!TON_API_KEY) {
  console.error('Error: TON_API_KEY is not set');
  console.error('Buy notifications will not work without TON_API_KEY');
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
let lastProcessedTimestamp = Math.floor(Date.now() / 1000) - 600;
let adminChatId = null;

console.log('Telegram bot started successfully!');

// ==================== УТИЛИТЫ ДЛЯ АДРЕСОВ ====================

function crc16(data) {
  const poly = 0x1021;
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ poly) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc;
}

function hexToNonBounceable(hexAddress) {
  try {
    let workchain, hash;
    
    if (hexAddress.includes(':')) {
      const parts = hexAddress.split(':');
      workchain = parseInt(parts[0]);
      hash = parts[1];
    } else {
      workchain = 0;
      hash = hexAddress;
    }
    
    hash = hash.replace(/^0x/, '');
    const hashBytes = Buffer.from(hash, 'hex');
    if (hashBytes.length !== 32) {
      return hexAddress;
    }
    
    const tag = 0x51;
    const wcByte = workchain === -1 ? 0xff : workchain;
    
    const data = Buffer.alloc(34);
    data[0] = tag;
    data[1] = wcByte;
    hashBytes.copy(data, 2);
    
    const crc = crc16(data);
    
    const fullData = Buffer.alloc(36);
    data.copy(fullData);
    fullData[34] = (crc >> 8) & 0xff;
    fullData[35] = crc & 0xff;
    
    const base64 = fullData.toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    
    return base64;
  } catch (error) {
    console.error('Address conversion error:', error.message);
    return hexAddress;
  }
}

async function getAccountInfo(address) {
  try {
    const response = await fetch(
      `https://tonapi.io/v2/accounts/${address}`,
      {
        headers: {
          'Authorization': `Bearer ${TON_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) return null;

    const data = await response.json();
    return {
      name: data.name || null,
      address: data.address || address
    };
  } catch (error) {
    return null;
  }
}

async function formatBuyerAddress(hexAddress) {
  const accountInfo = await getAccountInfo(hexAddress);
  
  if (accountInfo && accountInfo.name) {
    return {
      display: accountInfo.name,
      link: hexAddress
    };
  }
  
  const nonBounceable = hexToNonBounceable(hexAddress);
  return {
    display: nonBounceable,
    link: hexAddress
  };
}

function getRocketString(volume) {
  const count = Math.min(10, Math.max(1, Math.floor(volume / 5)));
  return '🚀'.repeat(count);
}

function formatNumber(num) {
  return new Intl.NumberFormat('en-US').format(num);
}

function calculateMC(price) {
  if (price === null) return '???';
  const mc = price * TOTAL_SUPPLY;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(mc);
}

// ==================== УТИЛИТЫ ДЛЯ МОДЕРАЦИИ ====================

function parseDuration(durationStr) {
  const match = durationStr.match(/^(\d+)\s*(m|min|minutes?|h|hours?|d|days?|w|weeks?)$/i);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  let seconds;
  let displayText;

  if (unit.startsWith('m')) {
    seconds = value * 60;
    displayText = `${value} minute${value > 1 ? 's' : ''}`;
  } else if (unit.startsWith('h')) {
    seconds = value * 60 * 60;
    displayText = `${value} hour${value > 1 ? 's' : ''}`;
  } else if (unit.startsWith('d')) {
    seconds = value * 60 * 60 * 24;
    displayText = `${value} day${value > 1 ? 's' : ''}`;
  } else if (unit.startsWith('w')) {
    seconds = value * 60 * 60 * 24 * 7;
    displayText = `${value} week${value > 1 ? 's' : ''}`;
  } else {
    return null;
  }

  return { seconds, displayText };
}

// ==================== TON API ====================

async function getTransactions() {
  try {
    const response = await fetch(
      `https://tonapi.io/v2/blockchain/accounts/${BIDASK_POOL_ADDRESS}/transactions?limit=20`,
      {
        headers: {
          'Authorization': `Bearer ${TON_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`TON API error: ${response.status}`);
    }

    const data = await response.json();
    return data.transactions || [];
  } catch (error) {
    console.error('Error fetching transactions:', error.message);
    return [];
  }
}

async function getTokenPrice() {
  try {
    const response = await fetch(
      `https://tonapi.io/v2/rates?tokens=${TOKEN_ADDRESS}&currencies=usd`,
      {
        headers: {
          'Authorization': `Bearer ${TON_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Rates API error: ${response.status}`);
    }

    const data = await response.json();
    const price = data.rates?.[TOKEN_ADDRESS]?.prices?.USD;
    
    if (price) {
      return price;
    }
    
    throw new Error('Price not found in response');
  } catch (error) {
    console.error('Error fetching price:', error.message);
    return null;
  }
}

let cachedTokenImage = null;

async function getTokenImage() {
  if (cachedTokenImage) {
    return cachedTokenImage;
  }
  
  try {
    const response = await fetch(
      `https://tonapi.io/v2/jettons/${TOKEN_ADDRESS}`,
      {
        headers: {
          'Authorization': `Bearer ${TON_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Jetton API error: ${response.status}`);
    }

    const data = await response.json();
    const imageUrl = data.metadata?.image || data.preview || null;
    
    if (imageUrl) {
      console.log(`Token logo: ${imageUrl}`);
      cachedTokenImage = imageUrl;
      return imageUrl;
    }
    
    return null;
  } catch (error) {
    console.error('Error fetching token logo:', error.message);
    return null;
  }
}

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
    const hash = tx.hash || '';
    const timestamp = tx.utime || 0;

    return {
      volume: value,
      buyer: buyer,
      hash: hash,
      timestamp: timestamp
    };
  } catch (error) {
    console.error('Error parsing transaction:', error.message);
    return null;
  }
}

// ==================== УВЕДОМЛЕНИЯ О ПОКУПКАХ ====================

async function sendBuyNotification(buyData, price) {
  if (!adminChatId) {
    console.log('Admin chat ID not set. Send /start to the bot.');
    return;
  }

  const rockets = getRocketString(buyData.volume);
  const mc = calculateMC(price);
  
  const buyerInfo = await formatBuyerAddress(buyData.buyer);
  const buyerDisplay = buyerInfo.display.length > 20 
    ? buyerInfo.display.substring(0, 17) + '...' 
    : buyerInfo.display;

  const caption = `<b>NEW BUY!</b> ${rockets}

💎 <b>${formatNumber(buyData.volume)} TON</b>

🦑 <a href="https://tonviewer.com/${buyerInfo.link}">${buyerDisplay}</a> | <a href="https://tonviewer.com/transaction/${buyData.hash}">Txn</a>

🌐 MC: ${mc}`;

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: 'DTRADE',
          url: `https://t.me/dtrade?start=26RoWqxLlD_${TOKEN_ADDRESS}`
        },
        {
          text: 'Graph',
          url: `https://x1000.finance/tokens/${TOKEN_ADDRESS}?ref=nextmayor`
        }
      ],
      [
        {
          text: 'JOIN HOLDERS CHAT',
          url: 'https://t.me/tondev_jetton/289'
        }
      ]
    ]
  };

  try {
    const tokenImage = await getTokenImage();
    
    if (tokenImage) {
      await bot.sendPhoto(adminChatId, tokenImage, {
        caption: caption,
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
      console.log(`Sent photo notification for ${buyData.volume} TON buy`);
    } else {
      await bot.sendMessage(adminChatId, caption, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: keyboard
      });
      console.log(`Sent text notification for ${buyData.volume} TON buy`);
    }
  } catch (error) {
    console.error('Error sending message:', error.message);
    try {
      await bot.sendMessage(adminChatId, caption, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: keyboard
      });
    } catch (fallbackError) {
      console.error('Fallback error:', fallbackError.message);
    }
  }
}

// ==================== МОНИТОРИНГ ====================

async function monitorTransactions() {
  if (!TON_API_KEY) return;
  
  console.log('Checking for new transactions...');

  const transactions = await getTransactions();
  const price = await getTokenPrice();
  
  let newBuysCount = 0;

  for (const tx of transactions) {
    if (tx.utime <= lastProcessedTimestamp) {
      continue;
    }

    const buyData = parseBuyTransaction(tx);
    if (buyData) {
      console.log(`BUY FOUND: ${buyData.volume} TON`);
      await sendBuyNotification(buyData, price);
      newBuysCount++;
      
      if (buyData.timestamp > lastProcessedTimestamp) {
        lastProcessedTimestamp = buyData.timestamp;
      }
    }
  }

  if (newBuysCount > 0) {
    console.log(`Processed ${newBuysCount} new buys`);
  }
}

// ==================== CA INFO (из admin бота) ====================

const sendCAInfo = (chatId) => {
  const message = `
🏴 [SWAP ON BIDASK](https://bidask.finance/en/app/swap/ton/${TOKEN_ADDRESS})
💸 [TRADE ON @dtrade](https://t.me/dtrade?start=26RoWqxLlD_${TOKEN_ADDRESS})

CA: \`${TOKEN_ADDRESS}\`
  `;

  bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  });
};

// ==================== КОМАНДЫ БОТА ====================

// /start - активация бота и показ CA
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  
  // Устанавливаем adminChatId для уведомлений о покупках
  if (msg.chat.type === 'private' || msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
    adminChatId = chatId;
    console.log(`Admin chat ID set: ${adminChatId}`);
  }
  
  // Показываем CA info
  sendCAInfo(chatId);
  
  // Дополнительное сообщение о мониторинге
  if (TON_API_KEY) {
    bot.sendMessage(chatId, `
✅ <b>Buy Bot activated!</b>

Minimum buy: <b>${MIN_BUY_THRESHOLD} TON</b>
Buy notifications will be sent to this chat.

Commands: /status, /volume, /help
`, { parse_mode: 'HTML' });
  }
});

// /CA - показать CA
bot.onText(/\/CA/i, (msg) => {
  const chatId = msg.chat.id;
  sendCAInfo(chatId);
});

// /status - статус бота
bot.onText(/\/status/, (msg) => {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  
  bot.sendMessage(msg.chat.id, `
📊 <b>Bot Status</b>

✅ Active
⏱ Uptime: ${hours}h ${minutes}m
🎯 Min buy: ${MIN_BUY_THRESHOLD} TON
🔄 Check interval: ${POLL_INTERVAL / 1000}s
${TON_API_KEY ? '✅ TON API connected' : '❌ TON API not configured'}
`, { parse_mode: 'HTML' });
});

// /volume - показать/изменить порог
bot.onText(/\/volume(?:\s+(\d+(?:\.\d+)?))?/, (msg, match) => {
  if (adminChatId && msg.chat.id !== adminChatId) {
    bot.sendMessage(msg.chat.id, 'Only admin can use this command.');
    return;
  }
  
  const newVolume = match[1] ? parseFloat(match[1]) : null;
  
  if (newVolume === null) {
    bot.sendMessage(msg.chat.id, `
📊 <b>Current buy threshold</b>

Minimum volume: <b>${MIN_BUY_THRESHOLD} TON</b>

To change, use:
<code>/volume 10</code> — set threshold to 10 TON
`, { parse_mode: 'HTML' });
    return;
  }
  
  if (newVolume < 0.1) {
    bot.sendMessage(msg.chat.id, 'Minimum value: 0.1 TON');
    return;
  }
  
  if (newVolume > 10000) {
    bot.sendMessage(msg.chat.id, 'Maximum value: 10000 TON');
    return;
  }
  
  const oldVolume = MIN_BUY_THRESHOLD;
  MIN_BUY_THRESHOLD = newVolume;
  
  console.log(`Threshold changed: ${oldVolume} -> ${newVolume} TON`);
  
  bot.sendMessage(msg.chat.id, `
✅ <b>Threshold changed!</b>

Was: ${oldVolume} TON
Now: <b>${newVolume} TON</b>

Notifications will be sent for buys from ${newVolume} TON.
`, { parse_mode: 'HTML' });
});

// /help - помощь
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, `
📖 <b>Bot Commands</b>

<b>Info:</b>
/start, /CA - Show contract address
/status - Check bot status
/volume - Show/change minimum buy threshold
/help - Show this help

<b>Moderation (admins only):</b>
/mute 30m - Mute for 30 minutes (reply to message)
/mute 5h - Mute for 5 hours
/mute 3d - Mute for 3 days
/mute 1w - Mute for 1 week
/unmute - Unmute user (reply to message)

<b>How it works:</b>
Bot monitors TON blockchain and sends notifications when someone buys the token for ${MIN_BUY_THRESHOLD}+ TON.
`, { parse_mode: 'HTML' });
});

// /mute - замьютить пользователя
bot.onText(/\/mute\s+(.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const fromUserId = msg.from?.id;

  if (!fromUserId || !match) return;

  if (msg.chat.type === 'private') {
    bot.sendMessage(chatId, 'This command only works in group chats.');
    return;
  }

  if (!msg.reply_to_message) {
    bot.sendMessage(chatId, 'Reply to a user\'s message to mute them.');
    return;
  }

  try {
    const chatMember = await bot.getChatMember(chatId, fromUserId);
    const isAdmin = ['creator', 'administrator'].includes(chatMember.status);

    if (!isAdmin) {
      bot.sendMessage(chatId, 'Only admins can use this command.');
      return;
    }

    const durationStr = match[1].trim();
    const duration = parseDuration(durationStr);

    if (!duration) {
      bot.sendMessage(chatId, '❌ Specify mute duration. Examples:\n/mute 30m — 30 minutes\n/mute 5h — 5 hours\n/mute 3d — 3 days\n/mute 1w — 1 week');
      return;
    }

    const targetUser = msg.reply_to_message.from;
    if (!targetUser) {
      bot.sendMessage(chatId, 'Could not identify the user to mute.');
      return;
    }

    const untilDate = Math.floor(Date.now() / 1000) + duration.seconds;

    await bot.restrictChatMember(chatId, targetUser.id, {
      until_date: untilDate,
      permissions: {
        can_send_messages: false,
        can_send_audios: false,
        can_send_documents: false,
        can_send_photos: false,
        can_send_videos: false,
        can_send_video_notes: false,
        can_send_voice_notes: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false,
        can_change_info: false,
        can_invite_users: false,
        can_pin_messages: false,
        can_manage_topics: false
      }
    });

    const userName = targetUser.first_name + (targetUser.last_name ? ` ${targetUser.last_name}` : '');
    bot.sendMessage(chatId, `🔇 ${userName} was muted for ${duration.displayText}`);

  } catch (error) {
    console.error('Mute error:', error);
    if (error.message?.includes('not enough rights')) {
      bot.sendMessage(chatId, 'I need to be an admin with "Restrict members" permission to mute users.');
    } else if (error.message?.includes('user is an administrator')) {
      bot.sendMessage(chatId, 'Cannot mute an administrator.');
    } else {
      bot.sendMessage(chatId, 'Failed to mute user. Make sure I have the right permissions.');
    }
  }
});

// /unmute - размьютить пользователя
bot.onText(/\/unmute/i, async (msg) => {
  const chatId = msg.chat.id;
  const fromUserId = msg.from?.id;

  if (!fromUserId) return;

  if (msg.chat.type === 'private') {
    bot.sendMessage(chatId, 'This command only works in group chats.');
    return;
  }

  if (!msg.reply_to_message) {
    bot.sendMessage(chatId, 'Reply to a user\'s message to unmute them.');
    return;
  }

  try {
    const chatMember = await bot.getChatMember(chatId, fromUserId);
    const isAdmin = ['creator', 'administrator'].includes(chatMember.status);

    if (!isAdmin) {
      bot.sendMessage(chatId, 'Only admins can use this command.');
      return;
    }

    const targetUser = msg.reply_to_message.from;
    if (!targetUser) {
      bot.sendMessage(chatId, 'Could not identify the user to unmute.');
      return;
    }

    await bot.restrictChatMember(chatId, targetUser.id, {
      permissions: {
        can_send_messages: true,
        can_send_audios: true,
        can_send_documents: true,
        can_send_photos: true,
        can_send_videos: true,
        can_send_video_notes: true,
        can_send_voice_notes: true,
        can_send_polls: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true,
        can_change_info: false,
        can_invite_users: true,
        can_pin_messages: false,
        can_manage_topics: false
      }
    });

    const userName = targetUser.first_name + (targetUser.last_name ? ` ${targetUser.last_name}` : '');
    bot.sendMessage(chatId, `✅ ${userName} was unmuted`);

  } catch (error) {
    console.error('Unmute error:', error);
    if (error.message?.includes('not enough rights')) {
      bot.sendMessage(chatId, 'I need to be an admin with "Restrict members" permission to unmute users.');
    } else {
      bot.sendMessage(chatId, 'Failed to unmute user. Make sure I have the right permissions.');
    }
  }
});

// Реакция на сообщения с "CA"
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';

  if (text.toUpperCase().includes('CA') && !text.startsWith('/')) {
    sendCAInfo(chatId);
  }
});

// ==================== ЗАПУСК ====================

console.log('Bot features:');
console.log('  - CA info (/start, /CA)');
console.log('  - Moderation (/mute, /unmute)');
if (TON_API_KEY) {
  console.log('  - Buy notifications (monitoring active)');
  console.log(`  - Token: ${TOKEN_ADDRESS}`);
  console.log(`  - Min buy: ${MIN_BUY_THRESHOLD} TON`);
  console.log(`  - Check interval: ${POLL_INTERVAL / 1000}s`);
  
  // Запуск мониторинга
  setInterval(monitorTransactions, POLL_INTERVAL);
} else {
  console.log('  - Buy notifications DISABLED (no TON_API_KEY)');
}

console.log('\nSend /start to the bot in Telegram to activate notifications\n');

// Обработка ошибок
process.on('unhandledRejection', (error) => {
  console.error('Unhandled error:', error);
});

process.on('SIGINT', () => {
  console.log('\nBot stopped');
  process.exit(0);
});
