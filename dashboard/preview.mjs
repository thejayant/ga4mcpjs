// Local preview: runs the built dashboard inside a simulated MCP Apps host,
// answering tool calls with the real server code and test fixtures.
// Usage: node dashboard/preview.mjs <playwright-module-path> <out-dir>
import { readFileSync } from 'node:fs';
import { registerDashboard } from './server.js';
import { fixtureDeps } from './fixtures.js';

const [playwrightPath, outDir] = process.argv.slice(2);
const { chromium } = await import(playwrightPath);
const tools = {};
registerDashboard({ registerTool: (name, config, handler) => { tools[name] = handler; }, registerResource() {} }, fixtureDeps().deps);
const app = readFileSync(new URL('./dist/dashboard.html', import.meta.url), 'utf8');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
const errors = [], messages = [];
async function session({ theme = 'light', width = 1440, height = 1000, reducedMotion = 'no-preference', open = null }) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion });
  const page = await context.newPage();
  page.on('console', msg => { if (msg.type() === 'error') errors.push(`${theme}/${width}: ${msg.text()}`); });
  page.on('pageerror', error => errors.push(`${theme}/${width}: ${error.message}`));
  await page.exposeFunction('callTool', async (name, args) => JSON.parse(JSON.stringify(await tools[name](args))));
  await page.exposeFunction('record', (method, params) => messages.push({ method, params }));
  await page.setContent(`<!doctype html><body style="margin:0"><iframe id="f" style="border:0;width:100vw;height:100vh"></iframe><script>
    const f = document.getElementById('f');
    window.addEventListener('message', async e => {
      const m = e.data; if (!m || m.jsonrpc !== '2.0' || e.source !== f.contentWindow) return;
      const reply = r => f.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, ...r }, '*');
      if (m.method === 'ui/initialize') {
        if (window.openResult) setTimeout(() => f.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: window.openResult }, '*'), 120);
        return reply({ result: { protocolVersion: m.params.protocolVersion, hostInfo: { name: 'test-host', version: '1' }, hostCapabilities: {}, hostContext: { theme: '${theme}', displayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'] } } });
      }
      if (m.method === 'tools/call') return reply({ result: await window.callTool(m.params.name, m.params.arguments) });
      if (m.id !== undefined) { await window.record(m.method, m.params); return reply({ result: {} }); }
      await window.record(m.method, m.params);
    });
  </script></body>`);
  const openResult = open ? JSON.parse(JSON.stringify(await tools.open_marketing_dashboard(open))) : null;
  await page.evaluate(({ html, openResult }) => {
    window.openResult = openResult;
    document.getElementById('f').srcdoc = html;
  }, { html: app, openResult });
  return { page, frame: () => page.frames()[1], context };
}
const settle = ms => new Promise(r => setTimeout(r, ms));
const full = { propertyId: 'properties/269500556', siteUrl: 'sc-domain:carportdirect.com', customerId: '2756458445', merchantAccountId: '121515117', gbpLocation: 'accounts/100440815877307284290/locations/3300504517304202205', callrailAccountId: 'ACCd5d9a974d27b4400bb7b69240fdb7e11' };

// 1. First run: account sheet opens over the welcome screen.
{
  const { page, context } = await session({});
  await settle(1500);
  await page.screenshot({ path: `${outDir}/01-first-run-sheet.png` });
  // pick every account through the real UI, then build
  const f = page.frames()[1];
  for (const [id, value] of Object.entries({ 'pick-ga4': full.propertyId, 'pick-search_console': full.siteUrl, 'pick-google_ads': full.customerId, 'pick-merchant_center': full.merchantAccountId, 'pick-gbp': full.gbpLocation, 'pick-callrail': full.callrailAccountId })) await f.selectOption(`#${id}`, value);
  await f.click('#sheet-apply');
  await settle(400);
  await page.screenshot({ path: `${outDir}/02-loading.png` });
  await settle(2200);
  await page.screenshot({ path: `${outDir}/03-overview.png`, fullPage: false });
  for (const view of ['ga4', 'search_console', 'google_ads', 'merchant_center', 'gbp', 'callrail']) {
    await f.click(`[data-view="${view}"]`);
    await settle(1700);
    const height = await f.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: 1440, height: Math.min(height, 2600) });
    await settle(300);
    await page.screenshot({ path: `${outDir}/04-${view}.png` });
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  // hover tooltip on the CallRail trend
  const box = await f.locator('.hit').boundingBox();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
  await settle(300);
  await page.screenshot({ path: `${outDir}/05-tooltip.png` });
  await f.click('#ask');
  await settle(300);
  await context.close();
}
// 2. Dark theme, remembered selection: loads straight into the overview.
{
  const { page, context } = await session({ theme: 'dark', open: full });
  await settle(2600);
  await page.screenshot({ path: `${outDir}/06-dark-overview.png` });
  await page.frames()[1].click('[data-view="google_ads"]');
  await settle(1700);
  await page.screenshot({ path: `${outDir}/07-dark-ads.png` });
  await context.close();
}
// 3. Phone width with reduced motion.
{
  const { page, context } = await session({ width: 390, height: 844, reducedMotion: 'reduce', open: full });
  await settle(1800);
  await page.screenshot({ path: `${outDir}/08-mobile-overview.png`, fullPage: true });
  const overflow = await page.frames()[1].evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log('mobile horizontal overflow px:', overflow);
  await page.frames()[1].click('[data-view="merchant_center"]');
  await settle(800);
  await page.screenshot({ path: `${outDir}/09-mobile-merchant.png`, fullPage: true });
  await context.close();
}
await browser.close();
console.log('host messages:', [...new Set(messages.map(m => m.method))].join(', '));
const ask = messages.find(m => m.method === 'ui/message');
console.log('ask prompt:', ask?.params?.content?.[0]?.text?.slice(0, 120));
console.log('context bytes:', JSON.stringify(messages.find(m => m.method === 'ui/update-model-context')?.params || {}).length);
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no console errors');
