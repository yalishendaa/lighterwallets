require('dotenv').config()
const fetch = require('node-fetch')
const { Telegraf } = require('telegraf')
const fs = require('fs')
const { toChecksumAddress } = require('web3-utils')

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

// Кеш для API запросов
const cache = new Map()
// Семафор для ограничения одновременных запросов
let activeRequests = 0
const requestQueue = []

// Rate limiting
const rateLimits = new Map()

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

// Rate limiting middleware
function checkRateLimit(userId) {
  const now = Date.now()
  const userLimits = rateLimits.get(userId) || { requests: [], blocked: false }
  
  // Очищаем старые запросы (старше минуты)
  userLimits.requests = userLimits.requests.filter(time => now - time < 60000)
  
  if (userLimits.requests.length >= CONFIG.RATE_LIMIT_PER_USER) {
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
    '/check <address|label> — Show current positions\n' +
    '/stats — Show your usage statistics\n\n' +
    '*Limits:*\n' +
    `• Maximum ${CONFIG.MAX_ADDRESSES_PER_USER} addresses per user\n` +
    `• Maximum ${CONFIG.RATE_LIMIT_PER_USER} commands per minute\n` +
    '• Position updates every 15 seconds'
  
  ctx.reply(helpMessage, { parse_mode: 'Markdown' })
})

bot.command('check', async ctx => {
  const userId = ctx.from.id
  const input = ctx.message.text.split(' ')[1]
  if (!input) return ctx.reply('Please provide address or label.')
  
  const watchlist = loadWatchlist()
  const userAddresses = watchlist[userId] || {}
  const match = Object.entries(userAddresses).find(([addr, lbl]) => lbl === input || addr === input)
  const address = match?.[0]
  const label = match?.[1] || 'Unnamed'
  
  if (!address) return ctx.reply('Address or label not found in your watchlist.')

  try {
    const data = await fetchPositions(address)
    const formatted = formatPositionsMobile(data.positions)

    // Рассчитываем среднее плечо
    const totalPositionValue = Object.values(data.positions)
      .reduce((sum, pos) => sum + (pos.position_value || 0), 0)

    const avgLeverage = data.balance > 0 ? (totalPositionValue / data.balance) : 0
    
    let header = `📊 <b>${label}</b>\n`
    header += `<code>${address.slice(0, 6)}...${address.slice(-4)}</code>\n`
    header += `Balance: <code>$${data.balance.toFixed(2)}</code>\n`
    header += `Avg Leverage: <code>${avgLeverage.toFixed(2)}x</code>\n`
    header += '\n━━━━━━━━━━━━━━━━━━━━\n\n'

    ctx.reply(header + formatted, { parse_mode: 'HTML' })
  } catch (error) {
    console.error('Error in check command:', error)
    ctx.reply('❌ Error fetching positions. Please try again later.')
  }
})

bot.command('add', async ctx => {
  const userId = ctx.from.id
  const input = ctx.message.text.split(' ').slice(1)
  if (input.length === 0) return ctx.reply('Usage: /add address [label]')

  const address = safeToChecksumAddress(input[0])
  if (!address) return ctx.reply('Invalid address.')

  const watchlist = loadWatchlist()
  const userAddresses = watchlist[userId] || {}
  
  if (Object.keys(userAddresses).length >= CONFIG.MAX_ADDRESSES_PER_USER) {
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
    
    ctx.reply(`✅ Added ${address}${label ? ' as ' + label : ''}\n\nAddresses: ${Object.keys(userAddresses).length}/${CONFIG.MAX_ADDRESSES_PER_USER}\n\n🔄 Monitoring started - you'll receive updates for any position changes.`)
  } catch (error) {
    console.error('Error initializing state for new address:', error)
    ctx.reply(`✅ Added ${address}${label ? ' as ' + label : ''}\n\nAddresses: ${Object.keys(userAddresses).length}/${CONFIG.MAX_ADDRESSES_PER_USER}\n\n⚠️ Warning: Could not fetch initial state. You may receive notifications about existing positions on first check.`)
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
  
  // Если никто больше не отслеживает этот адрес, удаляем его из состояния
  if (!stillTracked && previousStates[addr]) {
    delete previousStates[addr]
    saveState(previousStates)
  }
  
  const count = Object.keys(userAddresses).length
  ctx.reply(`✅ Removed ${addr}\n\nAddresses: ${count}/${CONFIG.MAX_ADDRESSES_PER_USER}`)
})

bot.command('list', ctx => {
  const userId = ctx.from.id
  const watchlist = loadWatchlist()
  const userAddresses = watchlist[userId] || {}
  
  if (Object.keys(userAddresses).length === 0) {
    return ctx.reply('Your watchlist is empty. Use /add to add addresses.')
  }
  
  const formatted = Object.entries(userAddresses)
    .map(([addr, lbl]) => `${lbl || '(no label)'}: \`${addr}\``)
    .join('\n')
  
  const count = Object.keys(userAddresses).length
  ctx.reply(`📋 *Your tracked wallets (${count}/${CONFIG.MAX_ADDRESSES_PER_USER}):*\n\n${formatted}`, { parse_mode: 'Markdown' })
})

// Улучшенный мониторинг с обработкой пользователей
setInterval(async () => {
  try {
    const watchlist = loadWatchlist()
    const allPromises = []
    
    // Собираем все адреса от всех пользователей
    const addressToUsers = new Map()
    Object.entries(watchlist).forEach(([userId, userAddresses]) => {
      Object.keys(userAddresses).forEach(address => {
        if (!addressToUsers.has(address)) {
          addressToUsers.set(address, [])
        }
        addressToUsers.get(address).push(userId)
      })
    })
    
    // Проверяем каждый уникальный адрес только один раз
    for (const [address, userIds] of addressToUsers) {
      allPromises.push(
        (async () => {
          try {
            const newState = await fetchPositions(address)
            const oldState = previousStates[address] || { positions: {} }
            const diffs = comparePositions(oldState, newState)

            if (diffs.length > 0) {
              // Отправляем уведомления всем пользователям, отслеживающим этот адрес
              for (const userId of userIds) {
                try {
                  const userAddresses = watchlist[userId] || {}
                  
                  await bot.telegram.sendMessage(
                    userId,
                    `📍 <b>${userAddresses[address] || 'Wallet'}</b>\n` +
                    `<code>${address.slice(0, 6)}...${address.slice(-4)}</code>\n\n` +
                    diffs.join('\n\n────────────────────\n\n'),
                    { parse_mode: 'HTML' }
                  )
                } catch (error) {
                  console.error(`Error sending notification to user ${userId}:`, error)
                }
              }
            }

            previousStates[address] = newState
          } catch (error) {
            console.error(`Error processing address ${address}:`, error)
          }
        })()
      )
    }
    
    // Ждем завершения всех запросов
    await Promise.allSettled(allPromises)
    saveState(previousStates)
    
    // Периодически очищаем кеш
    if (cache.size > 1000) {
      cache.clear()
    }
    
  } catch (error) {
    console.error('Error in monitoring loop:', error)
  }
}, CONFIG.CHECK_INTERVAL)

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
console.log('✅ Bot is running with enhanced stability and user limits...')
console.log(`📊 Config: ${CONFIG.MAX_ADDRESSES_PER_USER} addresses/user, ${CONFIG.RATE_LIMIT_PER_USER} requests/min, ${CONFIG.CHECK_INTERVAL/1000}s intervals`)
