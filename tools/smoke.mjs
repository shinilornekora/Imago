import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js';
const { chromium } = pw;

const URL = process.env.URL || 'http://127.0.0.1:8777/dev.html';
const OUT = process.env.OUT || '/tmp/claude-0/-home-claude/93135cb3-48e3-54e1-a4ab-603f1102094f/scratchpad';

const errors = [];
const logs = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => { logs.push(`${m.type()}: ${m.text()}`); if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + (e && e.message)));
page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url() + ' ' + (r.failure() && r.failure().errorText)));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const step = async (name, fn) => {
  try { await fn(); console.log('OK   ' + name); }
  catch (e) { console.log('FAIL ' + name + ' :: ' + (e && e.message)); errors.push(name + ': ' + (e && e.message)); }
};

await step('svg отрисован', async () => {
  const n = await page.locator('.imago-svg [data-id]').count();
  if (n < 5) throw new Error('узлов в svg: ' + n);
});
await step('слои заполнены', async () => {
  const n = await page.locator('#layers [data-id], #layers .layer').count();
  if (n < 3) throw new Error('строк в слоях: ' + n);
});
await page.screenshot({ path: OUT + '/shot-01-start.png' });

await step('клик по узлу выделяет', async () => {
  const el = page.locator('.imago-svg [data-id]').nth(3);
  await el.click({ force: true });
  await page.waitForTimeout(300);
  const vis = await page.locator('#inspector').isVisible();
  if (!vis) throw new Error('инспектор не открылся');
});
await page.screenshot({ path: OUT + '/shot-02-select.png' });

await step('команда агента создаёт узлы', async () => {
  const before = await page.locator('.imago-svg [data-id]').count();
  await page.fill('#command', 'добавь карточку оплаты');
  await page.click('#btn-run');
  await page.waitForTimeout(3000);
  const after = await page.locator('.imago-svg [data-id]').count();
  if (after <= before) throw new Error(`узлов было ${before}, стало ${after}`);
});
await page.screenshot({ path: OUT + '/shot-03-agent.png' });

await step('история содержит транзакцию агента', async () => {
  await page.click('#btn-history');
  await page.waitForTimeout(400);
  const n = await page.locator('#sheet-body .hitem').count();
  if (n < 1) { await page.keyboard.press('Escape'); throw new Error('пусто в истории'); }
  await page.click('#btn-sheet-close');
});
await step('undo/redo', async () => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const mid = await page.locator('.imago-svg [data-id]').count();
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);
  const after = await page.locator('.imago-svg [data-id]').count();
  if (after >= mid) throw new Error(`undo не сработал: ${mid} -> ${after}`);
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(400);
  const back = await page.locator('.imago-svg [data-id]').count();
  if (back !== mid) throw new Error(`redo не вернул: ${mid} -> ${back}`);
});
await step('варианты', async () => {
  await page.fill('#command', 'сделай три варианта карточки');
  await page.click('#btn-variants');
  await page.waitForTimeout(4000);
  const n = await page.locator('#variants .variant, #variants [data-variant]').count();
  if (n < 1) throw new Error('вариантов нет');
});
await page.screenshot({ path: OUT + '/shot-04-variants.png' });

await step('зум', async () => {
  await page.click('#btn-zoom-in');
  await page.waitForTimeout(200);
  await page.click('#btn-fit');
  await page.waitForTimeout(200);
});

const state = await page.evaluate(() => ({
  zoom: document.querySelector('#btn-zoom')?.textContent,
  toasts: document.querySelectorAll('.toast').length,
}));
console.log('state', JSON.stringify(state));

await page.screenshot({ path: OUT + '/shot-05-final.png' });

// мобильная ширина
await page.setViewportSize({ width: 420, height: 860 });
await page.waitForTimeout(500);
const hScroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
if (hScroll) errors.push('горизонтальный скролл на 420px');
await page.screenshot({ path: OUT + '/shot-06-mobile.png' });

await browser.close();

console.log('\n--- ошибки (' + errors.length + ') ---');
for (const e of errors.slice(0, 40)) console.log(e);
console.log('\n--- последние логи ---');
for (const l of logs.slice(-25)) console.log(l);
process.exit(errors.length ? 1 : 0);
