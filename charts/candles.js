const fetch = require('node-fetch')

async function getCandles(symbol = 'BTCUSDT', resolution = 60, exchange = 'binance-futures') {
  const now   = Date.now()
  const end   = now
  // если resolution заканчивается на 'D' — сутки в миллисекундах, иначе минуты
  const msPerCandle = String(resolution).endsWith('d')
    ? 24 * 60 * 60 * 1000          // 1D = сутки
    : Number(resolution) * 60_000  // минуты

  const begin = end - msPerCandle * 100  // 100 свечей/дней

  const url  = `https://velo.xyz/api/m/range`
             + `?exchange=${exchange}`
             + `&symbol=${symbol}`
             + `&begin=${begin}`
             + `&end=${end}`
             + `&resolution=${resolution}`

  const res  = await fetch(url)
  const json = await res.json()
  if (!json.arr || !Array.isArray(json.arr) || json.arr.length === 0) {
    throw new Error(`No data for ${symbol} on ${exchange}`)
  }

  return json.arr.map(([t, o, h, l, c, v]) => ({
    time:   t,    // в секундах
    open:   o,
    high:   h,
    low:    l,
    close:  c,
    volume: v
  }))
}

module.exports = { getCandles }
