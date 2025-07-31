require('dotenv').config()
const { Telegraf }   = require('telegraf')
const { getCandles } = require('./candles')
const { renderChart } = require('./render')

const bot = new Telegraf(process.env.BOT_TOKEN)

const EXCHANGES = [
  'binance-futures',
  'binance',
  'bybit',
  'bybit-futures',
  'deribit-futures',
  'okx-futures',
  'hyperliquid-futures',   // добавляем оба варианта Hyperliquid
  'hyperliquid',
  'coinbase',
]

// Интервалы в минутах (1d = 1440)
const resolutionMap = {
  '1m': 1,  '5m': 5,   '15m': 15,  '30m': 30,
  '1h': 60, '4h': 240, '1d': '1D',
}

// Приводим RAW (например "HYPE") к тому виду, который хочет API на каждой бирже
function normalizeSymbolForExchange(raw, exchange) {
  raw = raw.toUpperCase()
  // для Hyperliquid (любой его вариации) — знак через дефис и USD
  if (exchange.startsWith('hyperliquid')) {
    return raw.endsWith('-USD') ? raw : raw + '-USD'
  }
  // для остальных — пары к USDT
  return raw.endsWith('USDT') ? raw : raw + 'USDT'
}

async function handleChart(ctx, rawSymbol, interval, userEx) {
  const resolution = resolutionMap[interval]
  if (!resolution) {
    return ctx.reply(
      'Неверный таймфрейм, допустимые: ' +
      Object.keys(resolutionMap).join(', ')
    )
  }

  // выбираем, где искать: либо указанный юзером, либо полный список
  const exchanges = userEx
    ? [userEx]
    : EXCHANGES

  let candles, usedExchange, usedSymbol

outer:
  for (const ex of exchanges) {
    const symbol = normalizeSymbolForExchange(rawSymbol, ex)
    try {
      candles = await getCandles(symbol, resolution, ex)
      usedExchange = ex
      usedSymbol   = symbol
      break outer
    } catch (_) {
      // если не нашли — идём к следующей бирже
    }
  }

  if (!candles) {
    return ctx.reply(
      `Не удалось найти ${rawSymbol} на биржах`
    )
  }

  // Формат заголовка: УБИРАЕМ дефисы и заглавными
  const exchangeLabel = usedExchange.replace(/-/g, ' ').toUpperCase()

  try {
    const image = await renderChart({
      candles,
      ticker:   usedSymbol,
      interval,
      exchange: exchangeLabel
    })
    await ctx.replyWithPhoto({ source: image })
  } catch (err) {
    console.error(err)
    ctx.reply('Ошибка при генерации графика.')
  }
}

// Обычные сообщения, например "hype 1d" или "BTC 5m bybit"
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim()
  if (text.startsWith('/')) {
    // поддерживаем и команду /chart тоже
    const parts = text.replace(/^\//, '').split(' ')
    if (parts[0] === 'chart') parts.shift()
    else return
    // теперь parts = [SYMBOL, INTERVAL, EXCHANGE?]
    const [sym, intv, ex] = parts
    if (!sym || !resolutionMap[intv]) return
    return handleChart(ctx, sym, intv, ex)
  }

  // без слэша: просто "SYM TF [EX]"
  const [sym, intv, ex] = text.split(' ')
  if (!sym || !resolutionMap[intv]) return
  return handleChart(ctx, sym, intv, ex)
})

bot.launch()
