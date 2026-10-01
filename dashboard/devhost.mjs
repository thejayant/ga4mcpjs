// Local test host: serves the built dashboard inside a page that plays the MCP Apps
// host, answering tool calls with the real server code and test fixtures.
// Usage: node dashboard/devhost.mjs [port]   then open http://localhost:<port>
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { registerDashboard } from './server.js';
import { fixtureDeps } from './fixtures.js';

const port = Number(process.argv[2]) || 4318;
const tools = {};
registerDashboard({ registerTool: (name, config, handler) => { tools[name] = handler; }, registerResource() {} }, fixtureDeps().deps);

const host = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dashboard dev host</title>
<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style>
<iframe id="f"></iframe><script>
const f = document.getElementById('f');
const theme = new URLSearchParams(location.search).get('theme') || 'light';
window.addEventListener('message', async e => {
  const m = e.data; if (!m || m.jsonrpc !== '2.0' || e.source !== f.contentWindow) return;
  const reply = r => f.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, ...r }, '*');
  if (m.method === 'ui/initialize') {
    setTimeout(async () => {
      const open = await fetch('/tool', { method: 'POST', body: JSON.stringify({ name: 'open_marketing_dashboard', arguments: {} }) }).then(r => r.json());
      f.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: open }, '*');
    }, 100);
    return reply({ result: { protocolVersion: m.params.protocolVersion, hostInfo: { name: 'dev-host', version: '1' }, hostCapabilities: {}, hostContext: { theme, displayMode: 'fullscreen', availableDisplayModes: ['fullscreen'] } } });
  }
  if (m.method === 'tools/call') {
    const result = await fetch('/tool', { method: 'POST', body: JSON.stringify(m.params) }).then(r => r.json());
    return result.error ? reply({ error: { code: -32000, message: result.error } }) : reply({ result });
  }
  if (m.id !== undefined) { console.log('host request', m.method, m.params); return reply({ result: {} }); }
});
fetch('/app').then(r => r.text()).then(html => { f.srcdoc = html; });
</script>`;

createServer(async (req, res) => {
  if (req.url === '/app') return res.end(readFileSync(new URL('./dist/dashboard.html', import.meta.url)));
  if (req.url === '/tool' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { name, arguments: args } = JSON.parse(body);
    try { res.end(JSON.stringify(await tools[name](args || {}))); }
    catch (error) { res.end(JSON.stringify({ error: error.message })); }
    return;
  }
  res.setHeader('content-type', 'text/html'); res.end(host);
}).listen(port, () => console.log(`Dev host on http://localhost:${port}`));
