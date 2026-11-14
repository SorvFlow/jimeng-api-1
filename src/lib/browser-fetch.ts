import WebSocket from "ws";
import logger from "@/lib/logger.ts";
import db from "@/lib/database.ts";

let msgId = 1;


export function getCdpHttpBase(port?: string | number | null): string {
  // An explicit environment value is a fixed reverse-proxy endpoint. Keep its
  // exact port/path for deployments that intentionally proxy every CDP target.
  const explicitBase = String(process.env.DREAMINA_CDP_BASE || '').trim();
  if (explicitBase) return explicitBase.replace(/\/$/, "");

  const hasRequestedPort = port !== undefined && port !== null && String(port).trim() !== '';
  const cdpPort = String(port || process.env.DREAMINA_CDP_PORT || "64896");

  // This setting is written by automatic CDP discovery and may contain the
  // port of one particular BitBrowser window. When a caller supplies the
  // current window's port, preserve the discovered host but replace that old
  // port. With no explicit port, retain the stored endpoint for compatibility.
  const storedBase = String(db.getSetting('dreamina_cdp_base', '') || '').trim();
  if (storedBase) {
    if (!hasRequestedPort) return storedBase.replace(/\/$/, "");
    try {
      const stored = new URL(storedBase);
      return `${stored.protocol}//${stored.hostname}:${cdpPort}${stored.pathname === '/' ? '' : stored.pathname.replace(/\/$/, '')}`;
    } catch { /* fallback below */ }
  }

  // If only BitBrowser API is configured, derive CDP host/scheme from it.
  // BitBrowser /browser/open returns a local CDP port; on a remote BitBrowser
  // machine the CDP is normally exposed on the same host as the API.
  const bitbrowserApiBase = process.env.BITBROWSER_API_BASE || db.getSetting('bitbrowser_api_base', '');
  if (!process.env.DREAMINA_CDP_HOST && bitbrowserApiBase) {
    try {
      const api = new URL(bitbrowserApiBase);
      return `${api.protocol}//${api.hostname}:${cdpPort}`;
    } catch { /* fallback below */ }
  }

  const host = process.env.DREAMINA_CDP_HOST || "127.0.0.1";
  const scheme = process.env.DREAMINA_CDP_SCHEME || "http";
  return `${scheme}://${host}:${cdpPort}`;
}

/**
 * Read a CDP target list with a bounded request and useful diagnostics.
 * The optional caller signal is combined with an internal timeout so a stalled
 * BitBrowser endpoint cannot keep a login task pending indefinitely.
 */
export async function getCdpTargets(
  port: string | number,
  timeoutMs = 5000,
  signal?: AbortSignal,
): Promise<any[]> {
  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 5000;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const abortFromCaller = () => controller.abort(signal?.reason);

  if (signal?.aborted) abortFromCaller();
  else if (signal) signal.addEventListener('abort', abortFromCaller, { once: true });
  timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`CDP target request timeout after ${timeout}ms`));
  }, timeout);

  const base = getCdpHttpBase(port);
  const url = `${base.replace(/\/$/, '')}/json/list`;
  try {
    try {
      const response: any = await fetch(url, { signal: controller.signal });
      const status = Number(response?.status || 0);
      let raw = '';
      if (typeof response?.text === 'function') raw = await response.text();
      else if (typeof response?.json === 'function') raw = JSON.stringify(await response.json());
      if (response?.ok === false || (status && (status < 200 || status >= 300))) {
        throw new Error(`CDP target request HTTP ${status || 'unknown'}: ${String(raw).slice(0, 300)}`);
      }

      let parsed: any;
      try { parsed = JSON.parse(raw); }
      catch (error: any) {
        throw new Error(`CDP target response was not JSON: ${error?.message || error}; body=${String(raw).slice(0, 300)}`);
      }
      if (!Array.isArray(parsed)) {
        throw new Error(`CDP target response was not an array: ${JSON.stringify(parsed).slice(0, 300)}`);
      }
      return parsed;
    } catch (error: any) {
      if (timedOut) throw new Error(`CDP target request timeout after ${timeout}ms: ${url}`);
      if (signal?.aborted) throw new Error(`CDP target request aborted: ${url}`);
      const message = String(error?.message || error);
      if (/^CDP target (request HTTP|response was not)/.test(message)) throw error;
      throw new Error(`CDP target request failed: ${message}`);
    }
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function rewriteCdpWsUrl(wsUrl: string, port?: string | number | null): string {
  if (!wsUrl) return wsUrl;
  if (process.env.DREAMINA_CDP_WS_BASE) {
    const path = new URL(wsUrl).pathname;
    return `${process.env.DREAMINA_CDP_WS_BASE.replace(/\/$/, "")}${path}`;
  }
  const configuredBase = process.env.DREAMINA_CDP_BASE || db.getSetting('dreamina_cdp_base', '');
  const bitbrowserApiBase = process.env.BITBROWSER_API_BASE || db.getSetting('bitbrowser_api_base', '');
  if (!configuredBase && !process.env.DREAMINA_CDP_HOST && !bitbrowserApiBase) return wsUrl;
  const base = new URL(getCdpHttpBase(port));
  const u = new URL(wsUrl);
  u.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  u.hostname = base.hostname;
  u.port = base.port;
  return u.toString();
}

export async function getGeneratePageWs(port: string): Promise<string> {
  const base = getCdpHttpBase(port);
  const tabs = await getCdpTargets(port);
  const tab = tabs.find(t => t.type === 'page' && String(t.url || '').includes('/ai-tool/generate'))
    || tabs.find(t => t.type === 'page' && String(t.url || '').includes('dreamina.capcut.com'));
  if (!tab?.webSocketDebuggerUrl) throw new Error(`Dreamina CDP page not found on ${base}`);
  return rewriteCdpWsUrl(tab.webSocketDebuggerUrl, port);
}

export function cdpCall(ws: WebSocket, method: string, params: any = {}, timeoutMs = 30000): Promise<any> {
  const id = msgId++;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage as any);
      ws.removeEventListener('close', onClose as any);
      ws.removeEventListener('error', onError as any);
    };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const timer = setTimeout(() => fail(new Error(`CDP call timeout: ${method}`)), timeoutMs);
    const onClose = () => fail(new Error(`CDP connection closed: ${method}`));
    const onError = () => fail(new Error(`CDP websocket error: ${method}`));
    const onMessage = (ev: MessageEvent) => {
      let msg: any;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.id !== id) return;
      cleanup();
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMessage as any);
    ws.addEventListener('close', onClose as any);
    ws.addEventListener('error', onError as any);
    const readyState = (ws as any).readyState;
    if (typeof readyState === 'number' && readyState !== 1) {
      fail(new Error(`CDP websocket is not open: ${method}`));
      return;
    }
    try { ws.send(JSON.stringify({ id, method, params })); }
    catch (error: any) { fail(error); }
  });
}

export interface BrowserSignedRequest {
  url: string;
  headers: Record<string, string>;
  postData: string;
}

/**
 * Reuse Dreamina page secsdk/webmssdk to sign a request URL.
 *
 * The page's fetch is intercepted before it reaches the network. By the time
 * Fetch.requestPaused fires, secsdk has already appended msToken/X-Bogus/X-Gnarly
 * and browser headers. We cancel the browser request and return the signed URL
 * to the Node caller.
 */
export async function browserSignRequest(url: string, data: any, options: { cdpPort?: string | number | null; cdpWsUrl?: string | null } = {}): Promise<BrowserSignedRequest> {
  const port = String(options.cdpPort || process.env.DREAMINA_CDP_PORT || '64896');
  const wsUrl = options.cdpWsUrl || await getGeneratePageWs(port);
  const ws = new WebSocket(wsUrl);
  const targetPath = new URL(url).pathname;

  return await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage as any);
      ws.removeEventListener('close', onClose as any);
      ws.removeEventListener('error', onError as any);
    };
    const finish = (handler: (value?: any) => void, value?: any) => {
      if (settled) return;
      settled = true;
      cleanup();
      handler(value);
    };
    const fail = (error: any) => finish(reject, error instanceof Error ? error : new Error(String(error)));
    const timer = setTimeout(() => {
      fail(new Error('browserSignRequest timeout'));
      try { ws.close(); } catch {}
    }, 60000);
    const onClose = () => fail(new Error('CDP websocket closed before browser signing completed'));
    const onError = () => fail(new Error('CDP websocket error during browser signing'));
    const onMessage = async (ev: MessageEvent) => {
      let msg: any;
      try { msg = JSON.parse(String(ev.data)); }
      catch (error: any) { fail(new Error(`Invalid CDP message during browser signing: ${error?.message || error}`)); return; }
      if (msg.method !== 'Fetch.requestPaused' || settled) return;
      const p = msg.params;
      const reqUrl = p?.request?.url || '';
      if (!reqUrl.includes(targetPath)) return;

      try {
        await cdpCall(ws, 'Fetch.failRequest', {
          requestId: p.requestId,
          errorReason: 'Aborted'
        });
      } catch (error) {
        if (!settled) fail(error);
        return;
      }

      try { await cdpCall(ws, 'Fetch.disable'); } catch { /* ignore cleanup errors */ }
      let requestPath: string;
      try { requestPath = new URL(reqUrl).pathname; }
      catch (error: any) { fail(new Error(`Invalid signed browser request URL: ${error?.message || error}`)); return; }
      logger.info(`浏览器签名完成: ${requestPath}`);
      finish(resolve, {
        url: reqUrl,
        headers: p.request?.headers || {},
        postData: p.request?.postData || JSON.stringify(data),
      });
      try { ws.close(); } catch { /* ignore cleanup errors */ }
    };

    ws.addEventListener('message', onMessage as any);
    ws.addEventListener('close', onClose as any);
    ws.addEventListener('error', onError as any);

    ws.onopen = async () => {
      try {
        await cdpCall(ws, 'Fetch.enable', {
          patterns: [{ urlPattern: `*${targetPath}*`, requestStage: 'Request' }]
        });

        const expression = `
(async()=>{
  try {
    await fetch(${JSON.stringify(url)}, {
      method: 'POST',
      credentials: 'include',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(${JSON.stringify(data)})
    });
  } catch (e) {
    // Expected: Fetch domain aborts the signed browser request.
  }
  return true;
})()`;
        await cdpCall(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      } catch (e: any) {
        try { ws.close(); } catch {}
        fail(e);
      }
    };
  });
}

/** Fallback/direct browser fetch, useful for debugging. */
export async function browserFetchJson(url: string, data: any, options: { cdpPort?: string | number | null; cdpWsUrl?: string | null } = {}): Promise<any> {
  const port = String(options.cdpPort || process.env.DREAMINA_CDP_PORT || '64896');
  const wsUrl = options.cdpWsUrl || await getGeneratePageWs(port);
  const ws = new WebSocket(wsUrl);
  const evalId = msgId++;
  const expression = `
(async()=>{
  const res = await fetch(${JSON.stringify(url)}, {
    method: 'POST',
    credentials: 'include',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(${JSON.stringify(data)})
  });
  const text = await res.text();
  return JSON.stringify({status: res.status, url: res.url, text});
})()`;

  return await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage as any);
      ws.removeEventListener('close', onClose as any);
      ws.removeEventListener('error', onError as any);
    };
    const finish = (handler: (value?: any) => void, value?: any) => {
      if (settled) return;
      settled = true;
      cleanup();
      handler(value);
    };
    const fail = (error: any) => finish(reject, error instanceof Error ? error : new Error(String(error)));
    const timer = setTimeout(() => {
      fail(new Error('browserFetchJson timeout'));
      try { ws.close(); } catch {}
    }, 120000);
    const onClose = () => fail(new Error('CDP websocket closed before browser fetch completed'));
    const onError = () => fail(new Error('CDP websocket error during browser fetch'));
    const onMessage = (ev: MessageEvent) => {
      let msg: any;
      try { msg = JSON.parse(String(ev.data)); }
      catch (error: any) { fail(new Error(`Invalid CDP message during browser fetch: ${error?.message || error}`)); return; }
      if (msg.id !== evalId || settled) return;
      if (msg.error) { fail(new Error(JSON.stringify(msg.error))); return; }
      const raw = msg.result?.result?.value;
      let envelope: any;
      try { envelope = JSON.parse(raw); }
      catch (error: any) { fail(new Error(`Invalid browser fetch response: ${error?.message || error}`)); return; }
      if (!envelope || typeof envelope !== 'object') { fail(new Error('Invalid browser fetch response envelope')); return; }
      let responsePath: string;
      try { responsePath = new URL(envelope.url).pathname; }
      catch (error: any) { fail(new Error(`Invalid browser fetch response URL: ${error?.message || error}`)); return; }
      logger.info(`浏览器代理请求完成: ${envelope.status} ${responsePath}`);
      let body: any;
      try { body = JSON.parse(envelope.text); } catch { body = envelope.text; }
      if (envelope.status >= 400) { fail(new Error(`browser fetch HTTP ${envelope.status}: ${String(envelope.text).slice(0, 500)}`)); return; }
      finish(resolve, body);
      try { ws.close(); } catch {}
    };
    ws.addEventListener('message', onMessage as any);
    ws.addEventListener('close', onClose as any);
    ws.addEventListener('error', onError as any);
    ws.onopen = () => {
      try { ws.send(JSON.stringify({ id: evalId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); }
      catch (error) { fail(error); }
    };
  });
}
