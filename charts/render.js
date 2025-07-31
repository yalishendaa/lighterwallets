const fs        = require('fs')
const path      = require('path')
const puppeteer = require('puppeteer')

async function renderChart({ candles, ticker, interval, exchange }) {
  const tplPath = path.join(__dirname, 'chart.html')
  let html = fs.readFileSync(tplPath, 'utf8')

  html = html
    .replace('__DATA__',     JSON.stringify(candles))
    .replace('__TICKER__',   ticker)
    .replace('__INTERVAL__', interval)
    .replace('__EXCHANGE__', exchange)

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox']
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 800, height: 400 })
  await page.setContent(html, { waitUntil: 'networkidle0' })
  await new Promise(r => setTimeout(r, 200))
  const buffer = await page.screenshot({ type: 'png' })
  await browser.close()
  return buffer
}

module.exports = { renderChart }
