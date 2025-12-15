# Этапы обработки транзакций и используемые инструменты

## Описание процесса

1. **В блокчейне создается транзакция обмена в пуле**
   - Адрес пула: `0:ece84060d087c39351665aacb8bc176f603248338af66e4f4ff13529bb594686`
   - Тип транзакции: `bidask_damm_swap`
   - Покупка: в пул приходят TON, из пула выходят TONDEV
   - Продажа: в пул приходят TONDEV, из пула выходят TON

2. **Получение транзакций из блокчейна**
   - **Инструмент**: TON API (tonapi.io)
   - **Эндпоинт**: `https://tonapi.io/v2/blockchain/accounts/{POOL_ADDRESS}/transactions?limit=20`
   - **Метод**: HTTP GET с авторизацией через Bearer token
   - **Функция**: `getTransactions()`
   - **Лог префикс**: `[1. GET_TRANSACTIONS]`

3. **Парсинг транзакции и определение типа операции**
   - **Инструмент**: JavaScript логика в боте
   - **Функция**: `parseTransaction()`
   - **Лог префикс**: `[2. PARSE_TRANSACTION]`
   - Проверяет:
     - Наличие `in_msg` с `decoded_op_name === 'bidask_damm_swap'`
     - Для покупки: проверяет `decodedBody.native_amount`
     - Для продажи: проверяет `decodedBody.jetton === TOKEN_ADDRESS` и ищет исходящее сообщение с TON в `out_msgs` или `actions`

4. **Проверка порога**
   - **Инструмент**: JavaScript логика в боте
   - **Функция**: `parseTransaction()` (часть парсинга)
   - **Лог префикс**: `[3. CHECK_THRESHOLD]`
   - Для покупки: сравнивает `native_amount` с порогом (по умолчанию 5 TON)
   - Для продажи: сравнивает количество полученных TON с порогом

5. **Отправка уведомления**
   - **Инструмент**: Telegram Bot API (через библиотеку `node-telegram-bot-api`)
   - **Функция**: `sendNotification()`
   - **Лог префикс**: `[4. SEND_NOTIFICATION]`
   - Отправляет фото с токеном и кнопками, или текстовое сообщение

## Мониторинг

- **Функция**: `monitorTransactions()`
- **Интервал**: каждые 10 секунд (`POLL_INTERVAL = 10000`)
- **Лог префикс**: `[MONITOR]`

## Возможные проблемы

### Продажи не определяются
- ❌ Нет `decodedBody.jetton` или не совпадает с `TOKEN_ADDRESS`
- ❌ Не находится `sellerAddress` в транзакции
- ❌ Не находится исходящее сообщение с TON в `out_msgs` или `actions`
- ❌ Не совпадают адреса при сравнении через `addressesMatch()`
- ❌ Количество полученных TON ниже порога

### Транзакции теряются
- ❌ TON API не возвращает транзакции (проблема с API ключом или сетью)
- ❌ Транзакция слишком старая (проверка `tx.utime <= lastProcessedTimestamp`)
- ❌ Парсинг падает с ошибкой

## Как использовать логи

После запуска бота с добавленным логированием, в консоли будут видны все этапы:

```
[1. GET_TRANSACTIONS] 🔍 Fetching from TON API...
[1. GET_TRANSACTIONS] ✅ Received 20 transactions from TON API
[MONITOR] 📊 Processing 20 transactions, price: 0.001, lastProcessedTimestamp: 1234567890
[MONITOR] 💬 Processing chat 123456 with threshold 5 TON
[MONITOR] 🔍 Checking tx abc12345..., utime: 1234567891, lastProcessed: 1234567890
[3. CHECK_THRESHOLD] 🔍 Processing new tx, passing to parser...
[2. PARSE_TRANSACTION] 🔍 Parsing tx: abc12345...
[2. PARSE_TRANSACTION] 📋 Op name: bidask_damm_swap, has decodedBody: true
[2. PARSE_TRANSACTION] 🔍 SELL candidate detected (jetton matches)
[2. PARSE_TRANSACTION] 💎 TONDEV amount: 100
[2. PARSE_TRANSACTION] 🦑 Seller address: EQDKMh511DOn02mL0nf...
[2. PARSE_TRANSACTION] 🔍 Looking for TON out message in out_msgs (count: 2)
[2. PARSE_TRANSACTION]   out_msg[0]: destination=EQDKMh511DOn02mL0nf..., value=5000000000, jetton=no
[2. PARSE_TRANSACTION]   ✅ Destination matches seller!
[2. PARSE_TRANSACTION]   ✅ Found TON in out_msg: 5 TON
[2. PARSE_TRANSACTION] 💰 SELL detected: 100 TONDEV sold, 5 TON received, threshold: 5
[2. PARSE_TRANSACTION] ✅ SELL passed threshold: 5 >= 5
[2. PARSE_TRANSACTION] ✅ Parsed successfully: {...}
[3. CHECK_THRESHOLD] ✅ Transaction passed all checks: {...}
[4. SEND_NOTIFICATION] 📤 Sending notification for tx: abc12345..., type: SELL, chatId: 123456
[4. SEND_NOTIFICATION] ✅ Notification sent with photo to chat 123456
```

Если транзакция теряется, вы увидите на каком этапе это происходит и почему.

