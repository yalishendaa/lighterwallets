require('dotenv').config()
const fetch = require('node-fetch')
const { Telegraf } = require('telegraf')
const fs = require('fs')
const { toChecksumAddress } = require('web3-utils')

const BOT_TOKEN = process.env.BOT_TOKEN
const CHAT_ID = process.env.CHAT_ID
const API_URL_BASE = "https://mainnet.zklighter.elliot.ai/api/v1/account?by=l1_address&value="

const bot = new Telegraf(BOT_TOKEN)
bot.telegram.setMyCommands([
  { command: 'start', description: 'Menu' },
  { command: 'add', description: 'Add address with optional label' },
  { command: 'delete', description: 'Remove address from tracking' },
  { command: 'list', description: 'Show all tracked addresses' },
  { command: 'check', description: 'Show positions for address or label' },
  { command: 'menu', description: 'Show help and commands' }
])

const STATE_FILE = './state.json'
const WATCHLIST_FILE = './watchlist.json'

function safeToChecksumAddress(input) {
  try {
    return toChecksumAddress(input)
  } catch {
    return null
  }
}

function formatSideEmoji(sign) {
  return sign === 1 ? '🟢' : '🔴'
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE))
  } catch {
    return {}
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

function loadWatchlist() {
  try {
    return JSON.parse(fs.readFileSync(WATCHLIST_FILE))
  } catch {
    return {}
  }
}

function saveWatchlist(watchlist) {
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(watchlist, null, 2))
}

async function fetchPositions(addressRaw) {
  const address = safeToChecksumAddress(addressRaw)
  if (!address) return { balance: 0, positions: {} }
  try {
    const res = await fetch(API_URL_BASE + address)
    const json = await res.json()
    const acc = json.accounts?.[0]
    if (!acc) return { balance: 0, positions: {} }

    const positions = {}
    acc.positions.forEach(pos => {
      const size = parseFloat(pos.position)
      if (size !== 0) {
        positions[pos.symbol] = {
          position: Math.abs(size),
          avg_entry_price: parseFloat(pos.avg_entry_price),
          sign: pos.sign,
          open_order_count: pos.open_order_count,
          unrealized_pnl: parseFloat(pos.unrealized_pnl)
        }
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

function formatPositionsMono(positions) {
  const entries = Object.entries(positions)
  if (entries.length === 0) return 'No open positions.'

  const blocks = entries.map(([symbol, pos]) => {
    const pnlFormatted = (pos.unrealized_pnl >= 0 ? '+' : '') + pos.unrealized_pnl.toFixed(2)
    return (
      `${symbol.padEnd(6)} ${formatSideEmoji(pos.sign)}\n` +
      `Sz:  ${String(pos.position).padEnd(8)}\n` +
      `Ent: ${String(pos.avg_entry_price).padEnd(8)}\n` +
      `PNL: ${pnlFormatted.padEnd(8)}\n` +
      `Orders: ${pos.open_order_count}`
    )
  })

  const rows = []
  for (let i = 0; i < blocks.length; i += 3) {
    const row = blocks.slice(i, i + 3)
    const split = row.map(block => block.split('\n'))

    const maxLines = Math.max(...split.map(b => b.length))
    for (let j = 0; j < maxLines; j++) {
      const line = split.map(b => (b[j] || '').padEnd(24))
      rows.push(line.join(' '))
    }
    rows.push('')
  }

  return `<pre>${rows.join('\n')}</pre>`
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
      messages.push(`✅ *Opened* ${formatSideEmoji(n.sign)} position on *${sym}*\n\n*Size:* ${n.position}\n*Entry:* ${n.avg_entry_price}\n*Mark:* ${n.mark_price}\n*PNL:* ${n.unrealized_pnl.toFixed(4)}\n*Orders:* ${n.open_order_count}`)
    } else if (o && !n) {
      messages.push(`❌ *Closed* position on *${sym}*\n\n*Was:* ${formatSideEmoji(o.sign)} ${o.position} @ ${o.avg_entry_price}`)
    } else if (o && n && (o.position !== n.position || o.avg_entry_price !== n.avg_entry_price)) {
      const dir = n.position > o.position ? 'Increased' : 'Reduced'
      const direction = n.sign === 1 ? 'Long' : 'Short'
      let msg = `🔄 *${dir}* ${direction} position on *${sym}*\n\n*Size:* ${o.position} → ${n.position}`
      if (o.avg_entry_price !== n.avg_entry_price) {
        msg += `\n*Entry Price:* ${o.avg_entry_price} → ${n.avg_entry_price}`
      }
      msg += `\n*PNL:* ${n.unrealized_pnl.toFixed(4)}\n*Orders:* ${n.open_order_count}`
      messages.push(msg)
    }
  })
  return messages
}

let previousStates = loadState()

bot.command('start', ctx => {
  const helpMessage = '*Welcome!*\n\n' +
    'Here are the available commands:\n\n' +
    '/add <address> [label] — Add address to watchlist\n' +
    '/delete <address|label> — Remove from watchlist\n' +
    '/list — Show all tracked addresses\n' +
    '/check <address|label> — Show positions\n' +
    '/menu — Show this help'
  ctx.replyWithMarkdown(helpMessage)
})

bot.command('check', async ctx => {
  const input = ctx.message.text.split(' ')[1]
  if (!input) return ctx.reply('Please provide address or label.')
  const watchlist = loadWatchlist()
  const match = Object.entries(watchlist).find(([addr, lbl]) => lbl === input || addr === input)
  const address = match?.[0]
  const label = match?.[1] || 'Unnamed'
  if (!address) return ctx.reply('Address or label not found.')

  const data = await fetchPositions(address)
  const formatted = formatPositionsMono(data.positions)
  const header = `<b>Open positions for ${label}</b>\n<code>${address}</code>\n\n`
  ctx.reply(header + formatted, { parse_mode: 'HTML' })
})

bot.command('add', ctx => {
  const input = ctx.message.text.split(' ').slice(1)
  if (input.length === 0) return ctx.reply('Usage: /add address [label]')

  const address = safeToChecksumAddress(input[0])
  if (!address) return ctx.reply('Invalid address.')

  const label = input[1] || null
  const watchlist = loadWatchlist()
  watchlist[address] = label
  saveWatchlist(watchlist)
  ctx.reply(`Added ${address}${label ? ' as ' + label : ''}`)
})

bot.command('delete', ctx => {
  const input = ctx.message.text.split(' ')[1]
  if (!input) return ctx.reply('Usage: /delete address or label')

  const watchlist = loadWatchlist()
  const match = Object.entries(watchlist).find(([addr, lbl]) => lbl === input || addr === input)
  if (!match) return ctx.reply('Address or label not found.')

  const [addr] = match
  delete watchlist[addr]
  saveWatchlist(watchlist)
  ctx.reply(`Removed ${addr}`)
})

bot.command('list', ctx => {
  const watchlist = loadWatchlist()
  if (Object.keys(watchlist).length === 0) return ctx.reply('Watchlist is empty.')
  const formatted = Object.entries(watchlist).map(([addr, lbl]) => `${lbl || '(no label)'}: ${addr}`).join('\n')
  ctx.replyWithMarkdownV2('List of tracked wallets:' + '\n' + '\n' + formatted + '\n')
})

setInterval(async () => {
  const watchlist = loadWatchlist()
  for (const address of Object.keys(watchlist)) {
    const newState = await fetchPositions(address)
    const oldState = previousStates[address] || { positions: {} }
    const diffs = comparePositions(oldState, newState)

    if (diffs.length > 0) {
      const label = watchlist[address] ? ` (${watchlist[address]})` : ''
      await bot.telegram.sendMessage(
        CHAT_ID,
        `📡 Update for ${address}${label}\n\n` + diffs.join('\n\n'),
        { parse_mode: 'Markdown' }
      )
    }

    previousStates[address] = newState
  }

  saveState(previousStates)
}, 10_000) // проверка раз в минуту

bot.launch()
console.log('✅ Bot is running...')