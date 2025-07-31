const fs        = require('fs')
const path      = require('path')
const puppeteer = require('puppeteer')

async function renderChart({ candles, ticker, interval, exchange, avgLine = null, events = [] }) {
  const tplPath = path.join(__dirname, 'chart.html')
  let html = fs.readFileSync(tplPath, 'utf8')

  // Конвертируем events в нужный формат для маркеров
  const positions = events.map(event => ({
    time: new Date(event.time * 1000).toISOString(),
    type: event.side, // 'buy' или 'sell'
    price: event.price,
    size: 1 // можно добавить реальный размер позиции если есть
  }))

  html = html
    .replace('__DATA__', JSON.stringify(candles))
    .replace('__TICKER__', ticker || 'BTC/USD')
    .replace('__INTERVAL__', interval || '1m')
    .replace('__EXCHANGE__', exchange || 'BINANCE')
    .replace('__AVG_PRICE__', avgLine || 'null')
    .replace('__POSITIONS__', JSON.stringify(positions))

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox']
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 800, height: 400 })
  await page.setContent(html, { waitUntil: 'networkidle0' })
  await new Promise(r => setTimeout(r, 500)) // увеличиваем задержку для прорисовки
  const buffer = await page.screenshot({ type: 'png' })
  await browser.close()
  return buffer
}

module.exports = { renderChart }
