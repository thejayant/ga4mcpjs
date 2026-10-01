// Minimal MCP Apps client: JSON-RPC 2.0 over postMessage with the host window.
// Mirrors the parts of @modelcontextprotocol/ext-apps the dashboard uses, with
// no dependencies, so the bundle stays small and builds without a package manager.
const PROTOCOL_VERSION = '2026-01-26';
const TIMEOUT_MS = 90000;

export class HostBridge {
  constructor(appInfo, capabilities) {
    this.appInfo = appInfo;
    this.capabilities = capabilities;
    this.nextId = 1;
    this.pending = new Map();
    this.hostContext = {};
    this.ontoolresult = null;
    this.onhostcontextchanged = null;
    this.onMessage = this.onMessage.bind(this);
  }

  get embedded() { return window.parent !== window; }

  async connect() {
    window.addEventListener('message', this.onMessage);
    const result = await this.request('ui/initialize', { appInfo: this.appInfo, appCapabilities: this.capabilities, protocolVersion: PROTOCOL_VERSION });
    this.hostContext = result?.hostContext || {};
    this.hostCapabilities = result?.hostCapabilities || {};
    this.notify('ui/notifications/initialized', {});
    this.watchSize();
    return result;
  }

  send(message) { window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*'); }
  notify(method, params) { this.send({ method, params }); }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('The host did not respond in time.')); }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  onMessage(event) {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id !== undefined && !message.method) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message || 'Host request failed'));
      else waiter.resolve(message.result);
      return;
    }
    if (message.id !== undefined) return this.answer(message);
    if (message.method === 'ui/notifications/tool-result') this.ontoolresult?.(message.params || {});
    if (message.method === 'ui/notifications/host-context-changed') {
      this.hostContext = { ...this.hostContext, ...message.params };
      this.onhostcontextchanged?.(message.params || {});
    }
  }

  // Requests from the host: liveness and teardown are acknowledged; anything else is unsupported.
  answer(message) {
    if (message.method === 'ping' || message.method === 'ui/resource-teardown') return this.send({ id: message.id, result: {} });
    this.send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }

  callServerTool(name, args = {}) { return this.request('tools/call', { name, arguments: args }); }
  updateModelContext(params) { return this.request('ui/update-model-context', params); }
  sendMessage(text) { return this.request('ui/message', { role: 'user', content: [{ type: 'text', text }] }); }
  requestDisplayMode(mode) { return this.request('ui/request-display-mode', { mode }); }
  openLink(url) { return this.request('ui/open-link', { url }); }

  watchSize() {
    let last = '';
    const report = () => {
      const width = Math.ceil(document.documentElement.scrollWidth);
      const height = Math.ceil(document.documentElement.scrollHeight);
      const key = `${width}x${height}`;
      if (key === last) return;
      last = key;
      this.notify('ui/notifications/size-changed', { width, height });
    };
    new ResizeObserver(() => requestAnimationFrame(report)).observe(document.body);
  }
}
