import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js';
const { chromium } = pw;
const OUT = '/tmp/claude-0/-home-claude/93135cb3-48e3-54e1-a4ab-603f1102094f/scratchpad';
const browser = await chromium.launch();

// десктоп, светлая тема
for (const theme of ['dark', 'light']) {
  // colorScheme задаёт системную тему: без неё режим «как в системе» давал светлый кадр в обоих файлах
  const page = await browser.newPage({ viewport: { width: 1512, height: 900 }, colorScheme: theme });
  await page.addInitScript((t) => {
    try { localStorage.setItem('imago.settings.v1', JSON.stringify({ theme: t, rail: 'on', introSeen: true })); } catch (_) {}
  }, theme);
  await page.goto('http://127.0.0.1:8777/dev.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/ui-${theme}.png` });
  await page.close();
}

// мобильная ширина, чистый профиль
const m = await browser.newPage({ viewport: { width: 400, height: 820 } });
await m.goto('http://127.0.0.1:8777/dev.html', { waitUntil: 'networkidle' });
await m.waitForTimeout(1200);
await m.screenshot({ path: `${OUT}/ui-mobile.png` });
await m.locator('.imago-svg [data-id]').nth(4).click({ force: true });
await m.waitForTimeout(400);
await m.screenshot({ path: `${OUT}/ui-mobile-insp.png` });
await m.close();
await browser.close();
console.log('shots done');
