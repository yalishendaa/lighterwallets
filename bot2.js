require('dotenv').config()
const fetch = require('node-fetch')
const { Telegraf } = require('telegraf')
const fs = require('fs')
const { toChecksumAddress } = require('web3-utils')
const path = require('path')
const { getCandles } = require('./tgcharts/candles')
const { renderChart } = require('./tgcharts/render')

const BOT_TOKEN = process.env.BOT_TOKEN
const API_URL_BASE = "https://mainnet.zklighter.elliot.ai/api/v1/account?by=l1_address&value="
const CANDLE_API = "https://mainnet.zklighter.elliot.ai/api/v1/candlesticks"

// Конфигурация для устойчивости к нагрузкам
const CONFIG = {
  MAX_ADDRESSES_PER_USER: 5,
  CHECK_INTERVAL: 15000, // 15 секунд между проверками
  MAX_CONCURRENT_REQUESTS: 10,
  REQUEST_TIMEOUT: 10000, // 10 секунд таймаут
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 2000, // 2 секунды между ретраями
  RATE_LIMIT_PER_USER: 30, // команд в минуту на пользователя
  CACHE_DURATION: 30000 // 30 секунд кеш для API запросов
}

const bot = new Telegraf(BOT_TOKEN)
bot.telegram.setMyCommands([
  { command: 'start', description: 'Menu and help' },
  { command: 'add', description: 'Add address with optional label (max 5)' },
  { command: 'delete', description: 'Remove address from tracking' },
  { command: 'list', description: 'Show all your tracked addresses' },
  { command: 'check', description: 'Show positions for address or label' }
])

const STATE_FILE = './state.json'
const WATCHLIST_FILE = './watchlist.json'
const RATE_LIMIT_FILE = './rate_limits.json'
const WHITELIST_FILE = './whitelist.json'

// Кеш для API запросов
const cache = new Map()
// Семафор для ограничения одновременных запросов
let activeRequests = 0
const requestQueue = []

// Rate limiting
const rateLimits = new Map()

// Храним события покупок/продаж отдельно для каждого кошелька
// Структура: { address: { symbol: [events] } }
const tradeEventsByWallet = {}

function normalizeSymbol(raw, exch) {
  raw = raw.toUpperCase()
  if (exch.startsWith('hyperliquid')) {
    return raw.includes('-') ? raw : raw + '-USD'
  }
  return raw.endsWith('USDT') ? raw : raw + 'USDT'
}

function safeToChecksumAddress(input) {
  try {
    return toChecksumAddress(input)
  } catch {
    return null
  }
}

function formatSideEmoji(sign) {
  return sign === 1 ? '📗' : '📕'
}

function calculatePnLPercentage(pnl, entryPrice, position) {
  if (!entryPrice || !position || entryPrice === 0 || position === 0) return null
  const positionValue = entryPrice * position
  return (pnl / positionValue) * 100
}

// Функция для получения событий конкретного кошелька и символа
function getWalletEvents(address, symbol) {
  if (!tradeEventsByWallet[address]) {
    tradeEventsByWallet[address] = {}
  }
  if (!tradeEventsByWallet[address][symbol]) {
    tradeEventsByWallet[address][symbol] = []
  }
  return tradeEventsByWallet[address][symbol]
}

// Функция для добавления события торговли
function addTradeEvent(address, symbol, event) {
  const events = getWalletEvents(address, symbol)
  events.push(event)
  
  // Чистим старые события >24ч для этого кошелька и символа
  const now = Date.now() / 1000
  tradeEventsByWallet[address][symbol] = events.filter(e => now - e.time < 86400)
}

// Функция для очистки событий закрытого кошелька
function cleanupWalletEvents(address) {
  if (tradeEventsByWallet[address]) {
    delete tradeEventsByWallet[address]
  }
}

// Функция для определения типа операции для маркеров на графике
function getTradeTypeForChart(oldPos, newPos, symbol) {
  // Если позиция открылась
  if (!oldPos && newPos) {
    return newPos.sign === 1 ? 'buy' : 'sell'
  }
  
  // Если позиция закрылась
  if (oldPos && !newPos) {
    // При закрытии позиции происходит обратная операция
    return oldPos.sign === 1 ? 'sell' : 'buy'
  }
  
  // Если позиция изменилась по размеру
  if (oldPos && newPos && oldPos.position !== newPos.position) {
    const oldSize = oldPos.position
    const newSize = newPos.position
    const positionSign = newPos.sign // 1 = LONG, -1 = SHORT
    
    if (newSize > oldSize) {
      // Позиция увеличилась - добавляем в том же направлении
      return positionSign === 1 ? 'buy' : 'sell'
    } else if (newSize < oldSize) {
      // Позиция уменьшилась - частичное закрытие (обратная операция)
      // LONG уменьшается = SELL
      // SHORT уменьшается = BUY
      return positionSign === 1 ? 'sell' : 'buy'
    }
  }
  
  return null // нет изменений по размеру
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE))
  } catch {
    return {}
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  } catch (error) {
    console.error('Error saving state:', error)
  }
}

function loadWatchlist() {
  try {
    const data = JSON.parse(fs.readFileSync(WATCHLIST_FILE))
    // Убеждаемся что данные в правильном формате: userId -> {address -> label}
    return typeof data === 'object' && data !== null ? data : {}
  } catch {
    return {}
  }
}

function saveWatchlist(watchlist) {
  try {
    fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(watchlist, null, 2))
  } catch (error) {
    console.error('Error saving watchlist:', error)
  }
}

function loadRateLimits() {
  try {
    return JSON.parse(fs.readFileSync(RATE_LIMIT_FILE))
  } catch {
    return {}
  }
}

function saveRateLimits(limits) {
  try {
    fs.writeFileSync(RATE_LIMIT_FILE, JSON.stringify(limits, null, 2))
  } catch (error) {
    console.error('Error saving rate limits:', error)
  }
}

// Тихая проверка whitelist
function loadWhitelist() {
  try {
    const data = JSON.parse(fs.readFileSync(WHITELIST_FILE))
    return Array.isArray(data) ? data : []
  } catch {
    // Создаем пустой файл whitelist.json если его нет
    const emptyWhitelist = []
    try {
      fs.writeFileSync(WHITELIST_FILE, JSON.stringify(emptyWhitelist, null, 2))
    } catch (error) {
      console.error('Error creating whitelist file:', error)
    }
    return emptyWhitelist
  }
}

function isWhitelisted(userId) {
  const whitelist = loadWhitelist()
  return whitelist.includes(userId)
}

function getUserLimits(userId) {
  if (isWhitelisted(userId)) {
    return {
      maxAddresses: Infinity,
      rateLimit: Infinity
    }
  }
  return {
    maxAddresses: CONFIG.MAX_ADDRESSES_PER_USER,
    rateLimit: CONFIG.RATE_LIMIT_PER_USER
  }
}

// Rate limiting middleware с учетом whitelist
function checkRateLimit(userId) {
  const limits = getUserLimits(userId)
  if (limits.rateLimit === Infinity) return true
  
  const now = Date.now()
  const userLimits = rateLimits.get(userId) || { requests: [], blocked: false }
  
  // Очищаем старые запросы (старше минуты)
  userLimits.requests = userLimits.requests.filter(time => now - time < 60000)
  
  if (userLimits.requests.length >= limits.rateLimit) {
    userLimits.blocked = true
    return false
  }
  
  userLimits.requests.push(now)
  userLimits.blocked = false
  rateLimits.set(userId, userLimits)
  return true
}

// Функция для выполнения HTTP запросов с ретраями и таймаутом
async function fetchWithRetry(url, options = {}, retries = CONFIG.RETRY_ATTEMPTS) {
  const cacheKey = url
  const cachedResult = cache.get(cacheKey)
  
  if (cachedResult && Date.now() - cachedResult.timestamp < CONFIG.CACHE_DURATION) {
    return cachedResult.data
  }

  // Ждем освобождения слота для запроса
  if (activeRequests >= CONFIG.MAX_CONCURRENT_REQUESTS) {
    await new Promise(resolve => requestQueue.push(resolve))
  }

  activeRequests++
  
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT)
    
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    })
    
    clearTimeout(timeoutId)
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    
    const data = await response.json()
    
    // Кешируем результат
    cache.set(cacheKey, {
      data,
      timestamp: Date.now()
    })
    
    return data
  } catch (error) {
    if (retries > 0) {
      console.log(`Retrying request to ${url}, attempts left: ${retries - 1}`)
      await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY))
      return fetchWithRetry(url, options, retries - 1)
    }
    throw error
  } finally {
    activeRequests--
    if (requestQueue.length > 0) {
      const next = requestQueue.shift()
      next()
    }
  }
}

async function fetchPositions(addressRaw) {
  const address = safeToChecksumAddress(addressRaw)
  if (!address) return { balance: 0, positions: {} }
  
  try {
    const json = await fetchWithRetry(API_URL_BASE + address)
    const acc = json.accounts?.[0]
    if (!acc) return { balance: 0, positions: {} }

    const positions = {}
    const markPricePromises = []
    
    for (const pos of acc.positions) {
      const size = parseFloat(pos.position)
      if (size !== 0) {
        markPricePromises.push(
          fetchMarkPrice(pos.market_id).then(markPrice => ({
            symbol: pos.symbol,
            position: Math.abs(size),
            avg_entry_price: parseFloat(pos.avg_entry_price),
            sign: pos.sign,
            open_order_count: pos.open_order_count,
            unrealized_pnl: parseFloat(pos.unrealized_pnl),
            position_value: parseFloat(pos.position_value),
            mark_price: markPrice,
            market_id: pos.market_id
          }))
        )
      }
    }

    // Параллельно получаем все mark prices
    const positionsData = await Promise.allSettled(markPricePromises)
    
    positionsData.forEach(result => {
      if (result.status === 'fulfilled') {
        positions[result.value.symbol] = result.value
      }
    })

    return {
      balance: parseFloat(acc.collateral),
      positions
    }
  } catch (err) {
    console.error(`⚠️ Error fetching positions for ${address}:`, err.message)
    return { balance: 0, positions: {} }
  }
}

async function fetchMarkPrice(market_id) {
  const endTs = Date.now()
  const startTs = endTs - 60 * 1000
  const url = `${CANDLE_API}?market_id=${market_id}&resolution=1m&start_timestamp=${startTs}&end_timestamp=${endTs}&count_back=1`
  
  try {
    const json = await fetchWithRetry(url)
    const arr = Array.isArray(json.candlesticks) ? json.candlesticks : []
    if (arr.length === 0) return null
    return parseFloat(arr[arr.length - 1].close)
  } catch (err) {
    return null
  }
}

function formatPositionsMobile(positions) {
  const entries = Object.entries(positions)
  if (entries.length === 0) return '📭 <b>No open positions</b>'

  let result = ''
  entries.forEach(([symbol, pos], index) => {
    const pnlFormatted = (pos.unrealized_pnl >= 0 ? '+' : '') + pos.unrealized_pnl.toFixed(2)
    const markPriceStr = pos.mark_price ? pos.mark_price.toFixed(4) : 'N/A'
    const posValueStr = pos.position_value ? pos.position_value.toFixed(2) : 'N/A'
    const sideText = pos.sign === 1 ? 'LONG' : 'SHORT'

    // Рассчитываем процент PnL
    const pnlPercent = calculatePnLPercentage(pos.unrealized_pnl, pos.avg_entry_price, pos.position)
    const pnlPercentStr = pnlPercent !== null ? ` (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)` : ''
    
    result += `${formatSideEmoji(pos.sign)} <b>${symbol}</b> ${sideText}\n`
    result += `Size: <code>${pos.position}</code>\n`
    result += `Value: <code>$${posValueStr}</code>\n`
    result += `Entry: <code>$${pos.avg_entry_price}</code>\n`
    result += `Mark: <code>$${markPriceStr}</code>\n`
    result += `${pos.unrealized_pnl >= 0 ? '📈' : '📉'} PNL: <code>${pnlFormatted}$${pnlPercentStr}</code>\n`
    
    // Добавляем разделитель между позициями (кроме последней)
    if (index < entries.length - 1) {
      result += '\n━━━━━━━━━━━━━━━━━━━━\n\n'
    }
  })

  return result
}

function formatPositionUpdate(symbol, pos, action) {
  const sideText = pos.sign === 1 ? 'LONG' : 'SHORT'
  const pnlFormatted = (pos.unrealized_pnl >= 0 ? '+' : '') + pos.unrealized_pnl.toFixed(2)
  const markPriceStr = pos.mark_price ? pos.mark_price.toFixed(4) : 'N/A'
  const posValueStr = pos.position_value ? pos.position_value.toFixed(2) : 'N/A'
  
  // Рассчитываем процент PnL
  const pnlPercent = calculatePnLPercentage(pos.unrealized_pnl, pos.avg_entry_price, pos.position)
  const pnlPercentStr = pnlPercent !== null ? ` (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)` : ''
  
  let emoji = ''
  let title = ''
  
  switch (action) {
    case 'opened':
      emoji = '✅'
      title = 'POSITION OPENED'
      break
    case 'closed':
      emoji = '❌'
      title = 'POSITION CLOSED'
      break
    case 'increased':
      emoji = '📈'
      title = 'POSITION INCREASED'
      break
    case 'reduced':
      emoji = '📉'
      title = 'POSITION REDUCED'
      break
    default:
      emoji = '🔄'
      title = 'POSITION UPDATED'
  }
  
  let message = `${emoji} <b>${title}</b>\n\n`
  message += `${formatSideEmoji(pos.sign)} <b>${symbol}</b> ${sideText}\n\n`
  message += `<b>Size:</b> <code>${pos.position}</code>\n`
  message += `<b>Value:</b> <code>$${posValueStr}</code>\n`
  message += `<b>Entry:</b> <code>$${pos.avg_entry_price}</code>\n`
  message += `<b>Mark:</b> <code>$${markPriceStr}</code>\n`
  message += `${pos.unrealized_pnl >= 0 ? '📈' : '📉'} <b>PNL:</b> <code>${pnlFormatted}$${pnlPercentStr}</code>\n`

  return message
}

function comparePositions(oldPos, newPos) {
  const messages = []
  const oldPositions = oldPos.positions || {}
  const newPositions = newPos.positions || {}

  const allSymbols = new Set([...Object.keys(oldPositions), ...Object.keys(newPositions)])
  allSymbols.forEach(sym => {
    const o = oldPositions[sym]
    const n = newPositions[sym]
    
    if (!o && n) {
      // Новая позиция открыта
      messages.push(formatPositionUpdate(sym, n, 'opened'))
    } else if (o && !n) {
      // Позиция закрыта - добавляем процент PnL
      const pnlPercent = calculatePnLPercentage(o.unrealized_pnl, o.avg_entry_price, o.position)
      const pnlPercentStr = pnlPercent !== null ? ` (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)` : ''
      const pnlFormatted = (o.unrealized_pnl >= 0 ? '+' : '') + o.unrealized_pnl.toFixed(2)
      
      const closedMsg = `❌ <b>POSITION CLOSED</b>\n\n` +
        `${formatSideEmoji(o.sign)} <b>${sym}</b> ${o.sign === 1 ? 'LONG' : 'SHORT'}\n\n` +
        `<b>Size:</b> <code>${o.position}</code>\n` +
        `<b>Entry:</b> <code>$${o.avg_entry_price}</code>\n` +
        `${o.unrealized_pnl >= 0 ? '📈' : '📉'} <b>Final PNL:</b> <code>${pnlFormatted}$${pnlPercentStr}</code>`
      messages.push(closedMsg)
    } else if (o && n && (o.position !== n.position || o.avg_entry_price !== n.avg_entry_price)) {
      // Позиция изменена
      const action = n.position > o.position ? 'increased' : 'reduced'
      let msg = formatPositionUpdate(sym, n, action)
      
      // Добавляем информацию об изменении
      msg += `\n\n📊 <b>Changes:</b>`
      msg += `\n• Size: <code>${o.position} → ${n.position}</code>`
      
      if (o.avg_entry_price !== n.avg_entry_price) {
        msg += `\n• Entry: <code>$${o.avg_entry_price} → $${n.avg_entry_price}</code>`
      }
      
      messages.push(msg)
    }
  })
  return messages
}

// Middleware для проверки rate limit
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id
  if (!userId) return
  
  if (!checkRateLimit(userId)) {
    return ctx.reply('⚠️ Too many requests. Please wait a minute before trying again.')
  }
  
  try {
    await next()
  } catch (error) {
    console.error('Error processing command:', error)
    ctx.reply('❌ An error occurred. Please try again later.')
  }
})

let previousStates = loadState()

bot.command('start', ctx => {
  const helpMessage = '*Welcome to ZkLighter Position Tracker!*\n\n' +
    'This bot tracks your positions and sends updates.\n\n' +
    '*Available commands:*\n\n' +
    '/add <address> [label] — Add address to your watchlist (max 5)\n' +
    '/delete <address|label> — Remove from your watchlist\n' +
    '/list — Show all your tracked addresses\n' +
    '/check <address|label> — Show current positions\n\n' +
    '*Limits:*\n' +
    `• Maximum ${CONFIG.MAX_ADDRESSES_PER_USER} addresses per user\n` +
    `• Maximum ${CONFIG.RATE_LIMIT_PER_USER} commands per minute\n` +
    '• Position updates every 15 seconds'
  
  ctx.reply(helpMessage, { parse_mode: 'Markdown' })
})

bot.command('check', async ctx => {
  // 1. парсим ключ (адрес или метка)
  const parts = ctx.message.text.trim().split(/\s+/)
  const key = parts[1]
  if (!key) {
    return ctx.reply('используй: /check <адрес или метка>')
  }

  // 2. ищем address и label в watchlist
  const watchlist = loadWatchlist()
  const userList = watchlist[ctx.from.id] || {}
  let address, label

  const checksum = safeToChecksumAddress(key)
  if (checksum) {
    address = checksum
    label = userList[address] || key
  } else {
    const found = Object.entries(userList).find(([, lbl]) => lbl === key)
    if (!found) {
      return ctx.reply('адрес или метка не найдены')
    }
    address = found[0]
    label = key
  }

  // 3. получаем данные
  const data = await fetchPositions(address)
  const formatted = formatPositionsMobile(data.positions)

  // 4. считаем общее кол‑во лонгов и шортов
  const longs = Object.values(data.positions).filter(p => p.sign === 1)
  const shorts = Object.values(data.positions).filter(p => p.sign === -1)
  const longsCount  = Object.values(data.positions).filter(p => p.sign === 1).length
  const shortsCount = Object.values(data.positions).filter(p => p.sign === -1).length
  const longsValue  = longs.reduce((s, p) => s + (p.position_value || 0), 0)
  const shortsValue = shorts.reduce((s, p) => s + (p.position_value || 0), 0)

  // 5. формируем заголовок
  let header = `📊 <b>${label}</b>\n`
  header += `<code>${address.slice(0,6)}...${address.slice(-4)}</code>\n`
  header += `Balance: <code>$${data.balance.toFixed(2)}</code>\n`
  header += `Avg Leverage: <code>${(Object.values(data.positions)
    .reduce((s,p)=>s+(p.position_value||0),0) / data.balance || 0).toFixed(2)}x</code>\n`
  header += `Longs/Shorts count: <code>${longsCount}/${shortsCount}</code>\n`
  header += `Longs/Shorts value: <code>$${longsValue.toFixed(2)}/$${shortsValue.toFixed(2)}</code>\n`
  header += '\n━━━━━━━━━━━━━━━━━━━━\n\n'

  // 6. отправляем ответ
  ctx.reply(header + formatted, { parse_mode: 'HTML' })
})

bot.command('add', async ctx => {
  const userId = ctx.from.id
  const input = ctx.message.text.split(' ').slice(1)
  if (input.length === 0) return ctx.reply('Usage: /add address [label]')

  const address = safeToChecksumAddress(input[0])
  if (!address) return ctx.reply('Invalid address.')

  const watchlist = loadWatchlist()
  const userAddresses = watchlist[userId] || {}
  const limits = getUserLimits(userId)
  
  if (Object.keys(userAddresses).length >= limits.maxAddresses) {
    return ctx.reply(`❌ Maximum ${CONFIG.MAX_ADDRESSES_PER_USER} addresses allowed per user.`)
  }

  // Проверяем, не добавлен ли уже этот адрес
  if (userAddresses[address]) {
    return ctx.reply('❌ This address is already in your watchlist.')
  }

  const label = input[1] || null
  userAddresses[address] = label
  watchlist[userId] = userAddresses
  saveWatchlist(watchlist)
  
  // Инициализируем состояние для нового адреса, чтобы избежать ложных уведомлений
  try {
    const initialState = await fetchPositions(address)
    previousStates[address] = initialState
    saveState(previousStates)
    
    const maxDisplay = limits.maxAddresses === Infinity ? Object.keys(userAddresses).length : `${Object.keys(userAddresses).length}/${CONFIG.MAX_ADDRESSES_PER_USER}`
    ctx.reply(`✅ Added ${address}${label ? ' as ' + label : ''}\n\nAddresses: ${maxDisplay}\n\n🔄 Monitoring started - you'll receive updates for any position changes.`)
  } catch (error) {
    console.error('Error initializing state for new address:', error)
    const maxDisplay = limits.maxAddresses === Infinity ? Object.keys(userAddresses).length : `${Object.keys(userAddresses).length}/${CONFIG.MAX_ADDRESSES_PER_USER}`
    ctx.reply(`✅ Added ${address}${label ? ' as ' + label : ''}\n\nAddresses: ${maxDisplay}\n\n⚠️ Warning: Could not fetch initial state. You may receive notifications about existing positions on first check.`)
  }
})

bot.command('delete', ctx => {
  const userId = ctx.from.id
  const input = ctx.message.text.split(' ')[1]
  if (!input) return ctx.reply('Usage: /delete address or label')

  const watchlist = loadWatchlist()
  const userAddresses = watchlist[userId] || {}
  const match = Object.entries(userAddresses).find(([addr, lbl]) => lbl === input || addr === input)
  
  if (!match) return ctx.reply('Address or label not found in your watchlist.')

  const [addr] = match
  delete userAddresses[addr]
  watchlist[userId] = userAddresses
  saveWatchlist(watchlist)
  
  // Проверяем, отслеживает ли кто-то еще этот адрес
  const stillTracked = Object.values(watchlist).some(userAddr => userAddr[addr])
  
  // Если никто больше не отслеживает этот адрес, удаляем его из состояния И событий
  if (!stillTracked) {
    if (previousStates[addr]) {
      delete previousStates[addr]
      saveState(previousStates)
    }
    // Очищаем события торговли для этого кошелька
    cleanupWalletEvents(addr)
  }
  
  const limits = getUserLimits(userId)
  const count = Object.keys(userAddresses).length
  const maxDisplay = limits.maxAddresses === Infinity ? count : `${count}/${CONFIG.MAX_ADDRESSES_PER_USER}`
  ctx.reply(`✅ Removed ${addr}\n\nAddresses: ${maxDisplay}`)
})

bot.command('list', ctx => {
  const userId = ctx.from.id
  const watchlist = loadWatchlist()
  const userAddresses = watchlist[userId] || {}
  const limits = getUserLimits(userId)
  
  if (Object.keys(userAddresses).length === 0) {
    return ctx.reply('Your watchlist is empty. Use /add to add addresses.')
  }
  
  const formatted = Object.entries(userAddresses)
    .map(([addr, lbl]) => `${lbl || '(no label)'}: \`${addr}\``)
    .join('\n')
  
  const count = Object.keys(userAddresses).length
  const maxDisplay = limits.maxAddresses === Infinity ? count : `${count}/${CONFIG.MAX_ADDRESSES_PER_USER}`
  ctx.reply(`📋 *Your tracked wallets (${maxDisplay}):*\n\n${formatted}`, { parse_mode: 'Markdown' })
})

// ОБНОВЛЕННЫЙ МОНИТОРИНГ с разделением по кошелькам
setInterval(async () => {
  try {
    const watchlist = loadWatchlist()
    const addressToUsers = new Map()

    Object.entries(watchlist).forEach(([userId, addrs]) => {
      Object.keys(addrs).forEach(addr => {
        if (!addressToUsers.has(addr)) addressToUsers.set(addr, [])
        addressToUsers.get(addr).push({ userId, label: addrs[addr] || 'Wallet' })
      })
    })

    await Promise.allSettled(
      Array.from(addressToUsers.entries()).map(async ([address, userObjs]) => {
        const newState = await fetchPositions(address)
        const oldState = previousStates[address] || { positions: {} }
        const diffs = comparePositions(oldState, newState)
        if (!diffs.length) {
          previousStates[address] = newState
          return
        }

        for (const diff of diffs) {
          // разбор действия
          const symMatch = diff.match(/<b>(\w+)<\/b>/)
          if (!symMatch) continue
          const sym = symMatch[1]

          const oldPos = oldState.positions[sym]
          const newPos = newState.positions[sym]
          const currentPos = newPos || oldPos
          if (!currentPos) continue

          // Определяем правильный тип операции для графика
          const tradeType = getTradeTypeForChart(oldPos, newPos, sym)
          
          if (tradeType) {
            // Сохраняем событие для КОНКРЕТНОГО кошелька
            addTradeEvent(address, sym, {
              time: Math.floor(Date.now() / 1000),
              price: currentPos.avg_entry_price,
              side: tradeType
            })
          }

          // получаем свечи
          let candles = await getCandles(`${sym}USDT`, 1, 'binance-futures')
          if (!candles.length) continue

          // Получаем события ТОЛЬКО для этого кошелька и символа
          const walletEvents = getWalletEvents(address, sym)

          // рендер графика с маркерами только этого кошелька
          const imgBuffer = await renderChart({
            candles,
            ticker: `${sym}USDT`,
            interval: '1m',
            exchange: 'BINANCE FUTURES',
            avgLine: currentPos.avg_entry_price,
            events: walletEvents // события только этого кошелька!
          })

          // отправляем пользователям этого кошелька
          for (const { userId, label } of userObjs) {
            const caption =
              `📍 <b>${label}</b>\n` +
              `<code>${address.slice(0, 6)}...${address.slice(-4)}</code>\n\n` +
              `${diff}`

            await bot.telegram.sendPhoto(userId, { source: imgBuffer }, {
              caption,
              parse_mode: 'HTML'
            })
          }
        }

        previousStates[address] = newState
      })
    )

    saveState(previousStates)
  } catch (err) {
    console.error('Monitor error:', err)
  }
}, CONFIG.CHECK_INTERVAL)

// Периодическая очистка старых событий для всех кошельков
setInterval(() => {
  const now = Date.now() / 1000
  
  Object.keys(tradeEventsByWallet).forEach(address => {
    Object.keys(tradeEventsByWallet[address]).forEach(symbol => {
      tradeEventsByWallet[address][symbol] = tradeEventsByWallet[address][symbol].filter(
        e => now - e.time < 86400
      )
      
      // Удаляем пустые массивы событий
      if (tradeEventsByWallet[address][symbol].length === 0) {
        delete tradeEventsByWallet[address][symbol]
      }
    })
    
    // Удаляем пустые объекты кошельков
    if (Object.keys(tradeEventsByWallet[address]).length === 0) {
      delete tradeEventsByWallet[address]
    }
  })
}, 3600000) // каждый час

// Периодически сохраняем rate limits
setInterval(() => {
  const limitsObj = Object.fromEntries(rateLimits)
  saveRateLimits(limitsObj)
}, 30000)

// Загружаем rate limits при старте
const savedLimits = loadRateLimits()
Object.entries(savedLimits).forEach(([userId, data]) => {
  rateLimits.set(parseInt(userId), data)
})

// Handle graceful shutdown
process.once('SIGINT', () => {
  console.log('Shutting down gracefully...')
  saveState(previousStates)
  saveRateLimits(Object.fromEntries(rateLimits))
  bot.stop('SIGINT')
})

process.once('SIGTERM', () => {
  console.log('Shutting down gracefully...')
  saveState(previousStates)
  saveRateLimits(Object.fromEntries(rateLimits))
  bot.stop('SIGTERM')
})

bot.launch()

// Инициализация whitelist при запуске
loadWhitelist()

console.log('✅ Bot is running with silent whitelist support...')
console.log(`📊 Config: ${CONFIG.MAX_ADDRESSES_PER_USER} addresses/user, ${CONFIG.RATE_LIMIT_PER_USER} requests/min, ${CONFIG.CHECK_INTERVAL/1000}s intervals`)
console.log(`📄 Whitelist file: ${WHITELIST_FILE} (add user IDs to this file for unlimited access)`)
