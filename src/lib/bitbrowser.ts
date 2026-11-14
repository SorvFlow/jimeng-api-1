import WebSocket from "ws";
import axios, { AxiosInstance } from "axios";
import logger from "@/lib/logger.ts";
import db from "@/lib/database.ts";
import { cdpCall, getCdpHttpBase, getCdpTargets, getGeneratePageWs, rewriteCdpWsUrl } from "@/lib/browser-fetch.ts";

export interface BitBrowserOpenResult {
  ws?: string;
  http?: string;
  cdpPort?: number;
  seq?: number;
  name?: string;
  pid?: number;
  raw: any;
}

export interface DreaminaLoginResult {
  status: "ok" | "need_2fa" | "failed";
  message?: string;
  cookies?: string;
  cdpPort?: number;
  cdpWsUrl?: string;
  userAgent?: string;
}

export interface RunningDreaminaContext {
  cdpPort: number;
  pageWsUrl?: string;
  profileId?: string;
  pageUrl?: string;
  title?: string;
}

// Use the public Dreamina entry point supplied by the user. The page may show
// the sign-in CTA instead of opening the modal automatically; the automation
// below handles that CTA explicitly. Keep the URL configurable for deployments
// that need a regional mirror or a temporary query parameter.
const DEFAULT_LOGIN_URL = "https://dreamina.capcut.com/ai-tool/home";

function getDreaminaLoginUrl(explicit?: string): string {
  return String(explicit || process.env.DREAMINA_LOGIN_URL || db.getSetting('dreamina_login_url', DEFAULT_LOGIN_URL) || DEFAULT_LOGIN_URL).trim();
}

function getBaseUrl() {
  return process.env.BITBROWSER_API_BASE || db.getSetting('bitbrowser_api_base', 'http://127.0.0.1:54345');
}

function isPrivateIPv4(host: string): boolean {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || parts[0] === 192 && parts[1] === 168
    || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
}

function mask(value?: string | null) {
  if (!value) return "";
  return value.length <= 8 ? "****" : `${value.slice(0, 3)}****${value.slice(-3)}`;
}

function extractPort(openData: any): number | undefined {
  const candidates = [openData?.cdpPort, openData?.cdp_port,
    openData?.http, openData?.debuggerAddress, openData?.debugger_address, openData?.ws];
  for (const candidate of candidates) {
    const raw = String(candidate || "");
    const match = raw.match(/:(\d+)(?:\/|$)/) || raw.match(/^(\d+)$/);
    if (match) {
      const port = Number(match[1]);
      if (port > 0 && port < 65536) return port;
    }
  }
  return undefined;
}

function cdpBaseFromBitBrowserApi(bitbrowserApiBase: string, cdpPort: number): string {
  const api = new URL(bitbrowserApiBase);
  return `${api.protocol}//${api.hostname}:${cdpPort}`;
}

function getOpenArgs(): string[] {
  const raw = process.env.BITBROWSER_OPEN_ARGS || db.getSetting('bitbrowser_open_args', '');
  const args = raw
    ? raw.split(/\s*,\s*/).map(v => v.trim()).filter(Boolean)
    : [];

  if (!args.some(a => a.startsWith('--remote-debugging-address='))) {
    const explicitAddress = process.env.BITBROWSER_CDP_BIND_ADDRESS || db.getSetting('bitbrowser_cdp_bind_address', '');
    if (explicitAddress) {
      args.push(`--remote-debugging-address=${explicitAddress}`);
    } else {
      try {
        const apiHost = new URL(getBaseUrl()).hostname;
        if (apiHost === 'localhost' || apiHost === '127.0.0.1' || apiHost === '::1') {
          args.push('--remote-debugging-address=127.0.0.1');
        } else if (isPrivateIPv4(apiHost)) {
          args.push(`--remote-debugging-address=${apiHost}`);
        }
      } catch { /* Leave Chromium's loopback default for an unrecognized API host. */ }
    }
  }
  return args;
}

async function hasDreaminaPage(cdpPort: number): Promise<boolean> {
  try {
    const tabs = await getCdpTargets(cdpPort, 5000);
    return tabs.some(t => t.type === 'page' && String(t.url || '').includes('dreamina.capcut.com'));
  } catch {
    return false;
  }
}

function isCapcutDomain(value: any): boolean {
  const domain = String(value || '').toLowerCase().replace(/^\./, '');
  return domain === 'capcut.com' || domain.endsWith('.capcut.com')
    || domain === 'dreamina.com' || domain.endsWith('.dreamina.com');
}

function validDreaminaCookies(cookies: any[]): any[] {
  const now = Date.now() / 1000;
  return cookies.filter(c => {
    if (!isCapcutDomain(c?.domain) || String(c?.value ?? '').trim() === '') return false;
    // Chromium uses a negative expiry for session cookies. Never let an old
    // persistent cookie (or a same-named TikTok cookie in this Profile) pass.
    const expires = Number(c.expires);
    return c.expires === undefined || (Number.isFinite(expires)
      && (expires < 0 || expires > now || (expires === 0 && c.session === true)));
  });
}

function cookieHeaderFromCdp(cookies: any[]): string {
  return validDreaminaCookies(cookies)
    .map(c => `${c.name}=${c.value}`)
    .join("; ");
}

function norm(v: any): string {
  return String(v || "").trim().toLowerCase();
}

function parseProxyUrl(proxyUrl?: string | null): Partial<Record<string, any>> {
  const raw = String(proxyUrl || '').trim();
  // Local API: 2 = custom proxy (including noproxy), 3 = extract IP.
  if (!raw) return { proxyMethod: 2, proxyType: 'noproxy' };

  // Support both standard URL form and the imported shorthand form:
  //   http://user:pass@host:port
  //   user:pass@host:port
  const candidates = /^https?:\/\//i.test(raw) ? [raw] : [`http://${raw}`, raw];
  for (const candidate of candidates) {
    try {
      const u = new URL(candidate);
      const type = u.protocol.replace(':', '') || 'http';
      if (!u.hostname || !u.port) continue;
      return {
        proxyMethod: 2,
        proxyType: type === 'https' ? 'http' : type,
        host: u.hostname,
        port: Number(u.port || (type === 'https' ? 443 : 80)),
        proxyUserName: decodeURIComponent(u.username || ''),
        proxyPassword: decodeURIComponent(u.password || ''),
      };
    } catch {
      // Try next candidate.
    }
  }

  // BitBrowser requires proxyType even when falling back to no-proxy.
  return { proxyMethod: 2, proxyType: 'noproxy', remark: `Invalid proxy_url ignored: ${raw.slice(0, 80)}` };
}

function buildCreateProfilePayload(account: { name?: string; login_username?: string; username?: string; proxy_url?: string; region?: string }): any {
  const username = String(account.login_username || account.username || account.name || '').trim();
  const name = username || `Dreamina ${Date.now()}`;
  return {
    name,
    remark: `auto-created by jimeng-api${account.region ? ` / ${account.region}` : ''}`,
    url: DEFAULT_LOGIN_URL,
    ...parseProxyUrl(account.proxy_url),
    browserFingerPrint: {
      coreVersion: '124',
      ostype: 'PC',
      os: 'Win32',
      isIpCreateTimeZone: true,
      isIpCreateLanguage: true,
      isIpCreateDisplayLanguage: true,
      openWidth: 1280,
      openHeight: 900,
    },
  };
}

function extractProfileId(data: any): string {
  return String(data?.id || data?.browserId || data?.browser_id || data?.data?.id || data?.data?.browserId || data?.data?.browser_id || '').trim();
}


function getBitBrowserApiTimeoutMs(): number {
  const raw = process.env.BITBROWSER_API_TIMEOUT_MS || db.getSetting('bitbrowser_api_timeout_ms', '120000');
  const timeout = Number(raw);
  return Number.isFinite(timeout) && timeout >= 30000 ? timeout : 120000;
}

export class BitBrowserClient {
  private http: AxiosInstance;

  constructor(baseUrl = getBaseUrl()) {
    this.http = axios.create({ baseURL: baseUrl, timeout: getBitBrowserApiTimeoutMs(), validateStatus: () => true });
  }

  async list(page = 1, pageSize = 20): Promise<any[]> {
    const res = await this.http.post("/browser/list", { page, pageSize });
    if (!res.data?.success) throw new Error(res.data?.msg || `BitBrowser list failed: ${res.status}`);
    return res.data?.data?.list || [];
  }

  async listAll(maxPages = 30, pageSize = Number(process.env.BITBROWSER_LIST_PAGE_SIZE || 2)): Promise<any[]> {
    const all: any[] = [];
    for (let page = 1; page <= maxPages; page++) {
      let rows: any[] = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          rows = await this.list(page, pageSize);
          break;
        } catch (e) {
          const msg = String(e?.message || e || '');
          if (!/频繁|frequency|frequent|rate/i.test(msg) || attempt === 3) throw e;
          logger.warn(`BitBrowser list 触发限频，退避后重试: page=${page}, attempt=${attempt}`);
          await new Promise(r => setTimeout(r, 1500 * attempt));
        }
      }
      if (!rows.length) break;
      all.push(...rows);
      if (rows.length < pageSize) break;
      // BitBrowser local API can rate-limit rapid pagination requests.
      await new Promise(r => setTimeout(r, Number(process.env.BITBROWSER_LIST_DELAY_MS || 350)));
    }
    return all;
  }

  async findProfileForAccount(account: { name?: string; login_username?: string; username?: string; token_preview?: string }): Promise<any | null> {
    const targets = [account.login_username, account.username, account.name]
      .map(norm)
      .filter((target, index, all) => all.indexOf(target) === index)
      .filter(v => v && v !== "unknown");
    if (!targets.length) return null;

    const profiles = await this.listAll();

    // Prefer exact email/username matches; never bind by a partial name when
    // several BitBrowser Profiles could belong to different accounts.
    for (const target of targets) {
      const matches = profiles.filter(profile =>
        [profile.name, profile.userName, profile.username].map(norm).includes(target));
      if (matches.length > 1) {
        throw new Error(`BitBrowser 中有多个 Profile 精确匹配账号标识 ${mask(target)}，请手动绑定 Profile ID`);
      }
      if (matches.length === 1) return matches[0];
    }

    return null;
  }

  async detectDreaminaCdpBase(): Promise<{ cdpBase: string; profileId?: string; cdpPort: number; opened: BitBrowserOpenResult; hasDreaminaPage: boolean; warning?: string }> {
    const profiles = await this.listAll();
    const candidates = [
      ...profiles.filter(p => Number(p.status) === 1),
      ...profiles.filter(p => Number(p.status) !== 1),
    ];

    let lastError: any;
    let firstReachable: { cdpBase: string; profileId?: string; cdpPort: number; opened: BitBrowserOpenResult; hasDreaminaPage: boolean; warning?: string } | null = null;

    for (const profile of candidates) {
      try {
        const opened = await this.open(String(profile.id));
        if (!opened.cdpPort) continue;
        const cdpBase = cdpBaseFromBitBrowserApi(this.http.defaults.baseURL || getBaseUrl(), opened.cdpPort);
        const dreamina = await hasDreaminaPage(opened.cdpPort);
        const result = { cdpBase, profileId: String(profile.id), cdpPort: opened.cdpPort, opened, hasDreaminaPage: dreamina };
        if (dreamina) return result;
        if (!firstReachable) {
          firstReachable = {
            ...result,
            warning: "已检测到可访问的 CDP，但该窗口当前未打开 Dreamina 页面；保存后请在账号页点击“登录”或手动打开 dreamina.capcut.com。",
          };
        }
      } catch (e) {
        lastError = e;
      }
    }

    if (firstReachable) return firstReachable;
    throw new Error(lastError?.message || "未检测到可访问的 BitBrowser CDP。请确认远程服务器可访问 BitBrowser 返回的 CDP 端口，而不仅是 54345。");
  }

  async open(id: string): Promise<BitBrowserOpenResult> {
    if (!id) throw new Error("BitBrowser profile id is required");
    const res = await this.http.post("/browser/open", { id, args: getOpenArgs() });
    if (!res.data?.success) throw new Error(res.data?.msg || `BitBrowser open failed: ${res.status}`);
    const data = res.data.data || {};
    return { ...data, cdpPort: extractPort(data), raw: res.data };
  }

  async openForAccount(
    id: string,
    account: { proxy_url?: string | null },
    onProgress?: (message: string) => void | Promise<void>,
  ): Promise<BitBrowserOpenResult> {
    try {
      return await this.open(id);
    } catch (error: any) {
      const message = String(error?.message || error || '');
      if (String(account.proxy_url || '').trim() || !/dynamicIpUrl|提取URL/i.test(message)) throw error;

      // Repair only the exact invalid configuration created by older jimeng-api
      // versions. Never replace a manually configured or working proxy.
      let profile: any;
      try {
        const detail = await this.http.post('/browser/detail', { id });
        if (!detail.data?.success) throw new Error(detail.data?.msg || `HTTP ${detail.status}`);
        profile = detail.data.data;
      } catch (detailError: any) {
        throw new Error(`${message}；读取 Profile 代理配置失败：${detailError?.message || detailError}`);
      }
      const legacyNoProxy = String(profile?.id || '') === id
        && /^auto-created by jimeng-api(?:\s|$)/.test(String(profile?.remark || ''))
        && Number(profile?.proxyMethod) === 3 && profile?.proxyType === 'noproxy'
        && !profile?.isGlobalProxyInfo
        && !String(profile?.host || '').trim() && Number(profile?.port || 0) === 0
        && !String(profile?.proxyUserName || '').trim() && !String(profile?.proxyPassword || '').trim()
        && !String(profile?.dynamicIpUrl || '').trim();
      if (!legacyNoProxy) throw error;

      await onProgress?.('正在修复 BitBrowser 旧版无代理 Profile 配置');
      logger.warn(`修复旧版 BitBrowser 无代理配置: ${id} (proxyMethod 3 -> 2)`);
      try {
        // The proxy-only endpoint preserves cookies, fingerprint and window
        // settings. Do not send an incomplete profile to /browser/update.
        const updated = await this.http.post('/browser/proxy/update', {
          ids: [id],
          ipCheckService: profile.ipCheckService || 'ip-api',
          proxyMethod: 2,
          proxyType: 'noproxy',
        });
        if (!updated.data?.success) throw new Error(updated.data?.msg || `HTTP ${updated.status}`);
      } catch (updateError: any) {
        throw new Error(`${message}；修复旧版无代理 Profile 失败：${updateError?.message || updateError}`);
      }
      return this.open(id);
    }
  }

  async close(id: string): Promise<void> {
    if (!id) throw new Error("BitBrowser profile id is required");
    const res = await this.http.post("/browser/close", { id });
    if (!res.data?.success) throw new Error(res.data?.msg || `BitBrowser close failed: ${res.status}`);
  }

  async createOrUpdate(input: any): Promise<any> {
    // BitBrowser 本地 API 的新增/更新接口在不同版本里字段要求不同。
    // 这里提供透传封装：调用方传完整 browserFingerPrint / proxy 等 payload。
    const endpoint = input.id ? "/browser/update" : (process.env.BITBROWSER_CREATE_ENDPOINT || "/browser/update");
    const res = await this.http.post(endpoint, input);
    if (res.data?.success) return res.data.data || res.data;
    const detail = typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data || '');
    throw new Error(res.data?.msg || res.data?.message || `BitBrowser ${endpoint} failed: ${res.status}${detail ? ` ${detail}` : ''}`);
  }

  async createProfileForAccount(account: { name?: string; login_username?: string; username?: string; proxy_url?: string; region?: string }): Promise<any> {
    const payload = buildCreateProfilePayload(account);
    logger.info(`自动创建 BitBrowser profile: ${mask(payload.name)}`);
    const data = await this.createOrUpdate(payload);
    const profileId = extractProfileId(data);
    if (profileId) return { ...data, id: profileId, autoCreatedPayload: { name: payload.name, url: payload.url, proxyType: payload.proxyType, host: payload.host, port: payload.port } };

    // 某些 BitBrowser 版本创建接口只返回布尔值，不返回 id；创建后按名称再查一次。
    const matched = await this.findProfileForAccount(account);
    if (matched?.id) return matched;
    throw new Error('BitBrowser profile 已创建但未返回 profile id，且无法按账号名称重新匹配');
  }
}

function getCandidateCdpPorts(extra?: Array<number | string | null | undefined>): number[] {
  const values = [
    ...(extra || []),
    process.env.DREAMINA_CDP_PORT,
    process.env.BITBROWSER_CDP_PORT,
    ...(process.env.BITBROWSER_CDP_PORTS || '').split(',')
  ];
  if (!values.some(v => String(v || '').trim() === '64896')) values.push('64896');
  return [...new Set(values.map(v => Number(String(v || '').trim())).filter(v => Number.isInteger(v) && v > 0 && v < 65536))];
}

export async function discoverRunningDreaminaContext(extraPorts: Array<number | string | null | undefined> = []): Promise<RunningDreaminaContext | null> {
  for (const port of getCandidateCdpPorts(extraPorts)) {
    try {
      const tabs = await getCdpTargets(port, 5000);
      const dreaminaPage = tabs.find(t => t.type === 'page' && String(t.url || '').includes('dreamina.capcut.com'));
      if (!dreaminaPage) continue;
      const workbench = tabs.find(t => t.type === 'page' && String(t.url || '').includes('console.bitbrowser.net'));
      let profileId: string | undefined;
      if (workbench?.url) {
        try { profileId = new URL(workbench.url).searchParams.get('id') || undefined; } catch {}
      }
      return {
        cdpPort: port,
        pageWsUrl: rewriteCdpWsUrl(dreaminaPage.webSocketDebuggerUrl, port),
        profileId,
        pageUrl: dreaminaPage.url,
        title: dreaminaPage.title,
      };
    } catch {
      // Port is not a CDP endpoint, ignore.
    }
  }
  return null;
}

async function waitForPageWs(port: number, timeoutMs = 60000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: any;
  while (Date.now() < deadline) {
    try {
      return await getGeneratePageWs(String(port));
    } catch (e) {
      lastError = e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw lastError || new Error(`Dreamina page not found on CDP port ${port}`);
}

/** Return any usable page target, including a blank tab opened by BitBrowser. */
async function waitForAnyPageWs(port: number, timeoutMs = 15000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: any;
  while (Date.now() < deadline) {
    try {
      const tabs = await getCdpTargets(port, 5000);
      const target = tabs.find(t => t.type === 'page' && /\/scan-qr-code(?:[/?]|$)/i.test(String(t.url || '')))
        || tabs.find(t => t.type === 'page' && String(t.url || '').includes('/ai-tool/generate'))
        || tabs.find(t => t.type === 'page' && String(t.url || '').includes('dreamina.capcut.com'))
        || tabs.find(t => t.type === 'page' && /(?:^|[/:.])capcut\.com(?:\/|$)/i.test(String(t.url || '')))
        || tabs.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target?.webSocketDebuggerUrl) return rewriteCdpWsUrl(target.webSocketDebuggerUrl, port);
      lastError = new Error(`No page target on CDP port ${port}`);
    } catch (e) {
      lastError = e;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw lastError || new Error(`No page target on CDP port ${port}`);
}

async function evalOnPage<T = any>(ws: WebSocket, expression: string, timeoutMs = 30000, contextId?: number): Promise<T> {
  const params: any = { expression, awaitPromise: true, returnByValue: true };
  if (typeof contextId === 'number') params.contextId = contextId;
  const result = await cdpCall(ws, "Runtime.evaluate", params, timeoutMs);
  const remote = result?.result;
  if (remote?.subtype === "error") throw new Error(remote?.description || remote?.value || "Runtime.evaluate failed");
  return remote?.value as T;
}

/**
 * Dreamina 的第三方登录弹窗常渲染在同源 iframe 中；主 frame 里 querySelectorAll('input')
 * 找不到邮箱/密码框，导致状态机反复点击"使用电子邮件继续"却停在原地。
 * 这里枚举所有 execution context（主 frame + 各 iframe），返回第一个满足条件的 contextId。
 */
async function findContextIdWhere(ws: WebSocket, predicateExpr: string): Promise<number | undefined> {
  const contexts = await collectExecutionContexts(ws);
  for (const ctx of contexts) {
    const hit = await evalOnPage<boolean>(ws, predicateExpr, 10000, ctx).catch(() => false);
    if (hit) return ctx;
  }
  return undefined;
}

/**
 * 通过 Page.getFrameTree + Runtime.executionContextCreated 事件收集可用 contextId。
 * Runtime.enable 会为每个已存在的 context 重放 executionContextCreated 事件。
 */
async function collectExecutionContexts(ws: WebSocket, waitMs = 1200): Promise<Array<number | undefined>> {
  const ids = new Set<number>();
  const onMessage = (ev: MessageEvent) => {
    try {
      const msg = JSON.parse(String(ev.data));
      if (msg.method === 'Runtime.executionContextCreated' && typeof msg.params?.context?.id === 'number') {
        ids.add(msg.params.context.id);
      }
    } catch { /* 忽略非 JSON 帧 */ }
  };
  ws.addEventListener('message', onMessage as any);
  try {
    // 先 disable 再 enable，强制重放全部已存在 context（含 iframe）。
    await cdpCall(ws, 'Runtime.disable', {}, 5000).catch(() => null);
    await cdpCall(ws, 'Runtime.enable', {}, 5000).catch(() => null);
    await new Promise(r => setTimeout(r, waitMs));
  } finally {
    ws.removeEventListener('message', onMessage as any);
  }
  // undefined 代表默认（主 frame）context，始终最先尝试。
  return [undefined, ...ids];
}

function isCdpNavigationError(error: any): boolean {
  return /execution context.*(?:destroyed|not found|does not exist)|cannot find context|cannot find.*id|target.*(?:closed|not found)|session.*closed|websocket.*(?:closed|not open|error)|CDP connection closed/i.test(String(error?.message || error));
}

async function connectPageWebSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  // A target can disappear between calls; cdpCall reports errors while a call
  // is pending, and this listener keeps an idle transport error from escaping.
  socket.on('error', () => {});
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('CDP websocket connection timeout')), 10000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.removeListener('open', onOpen);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      if (error) {
        socket.once('error', () => {});
        try { socket.close(); } catch {}
        reject(error);
      } else resolve(socket);
    };
    const onOpen = () => finish();
    const onError = () => finish(new Error('CDP websocket error'));
    const onClose = () => finish(new Error('CDP connection closed'));
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

async function navigateAndWait(ws: WebSocket, url: string, reconnect?: () => Promise<WebSocket>): Promise<WebSocket> {
  await cdpCall(ws, "Page.enable");
  await cdpCall(ws, "Runtime.enable");
  try {
    await cdpCall(ws, "Page.navigate", { url });
  } catch (error) {
    if (!reconnect || !isCdpNavigationError(error)) throw error;
    ws = await reconnect();
  }
  // The Dreamina shell is client-rendered and may take longer than the
  // navigation response, especially through a remote BitBrowser proxy. Wait
  // for a usable body/login surface instead of racing the first 5 seconds.
  const configured = Number(process.env.DREAMINA_LOGIN_PAGE_WAIT_MS || 20000);
  const timeoutMs = Number.isFinite(configured) && configured >= 5000 ? configured : 20000;
  const deadline = Date.now() + timeoutMs;
  let lastState: any = null;
  // Give Chromium a turn to swap the document before inspecting readyState;
  // otherwise the old page can report `complete` immediately after navigate.
  await new Promise(r => setTimeout(r, 300));
  if (reconnect) ws = await reconnect();
  while (Date.now() < deadline) {
    lastState = await evalOnPage<any>(ws, `(() => ({
      ready: document.readyState,
      hasBody: !!document.body,
      textLength: document.body ? (document.body.innerText || '').trim().length : 0,
      controls: document.querySelectorAll('button,input,[role=button]').length
    }))()`, 5000).catch(async error => {
      if (reconnect && isCdpNavigationError(error)) ws = await reconnect();
      return null;
    });
    if (lastState?.hasBody && (lastState.textLength > 20 || lastState.controls > 0)) return ws;
    await new Promise(r => setTimeout(r, 500));
  }
  logger.warn(`Dreamina 页面在 ${timeoutMs}ms 内未完全就绪，继续尝试登录流程: ${JSON.stringify(lastState || {})}`);
  return ws;
}

/**
 * 可见性判断不能用 offsetParent：按 CSS 规范，position:fixed 元素的 offsetParent 为 null，
 * 而 Dreamina 登录弹窗正是 fixed 定位，会导致弹窗内的元素被误判为不可见。
 */
const VISIBLE_FN = `el => {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
}`;

async function clickTextByCdp(ws: WebSocket, pattern: string, flags = 'i', contextId?: number): Promise<boolean> {
  const expression = `(() => {
    const re = new RegExp(${JSON.stringify(pattern)}, ${JSON.stringify(flags)});
    const visible = ${VISIBLE_FN};
    const textOf = el => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
    const lineCount = el => textOf(el).split(String.fromCharCode(10)).filter(Boolean).length;
    const score = el => {
      const cls = String(el.className || '');
      const role = el.getAttribute('role') || '';
      const txt = textOf(el);
      return (el.matches('button,a,[role=button],[role=menuitem]') ? 120 : 0)
        + (/^sign in to claim$/i.test(txt) ? 300 : 0)
        + (/lv_new_third_part_sign_in_expand-button|login-button/i.test(cls) ? 220 : 0)
        + (/lv_new_third_part_sign_in_expand-wrapper/i.test(cls) ? 80 : 0)
        + (/email|mail|電子郵件|电子邮件|郵箱|邮箱|login|sign/i.test(cls + ' ' + txt) ? 80 : 0)
        + (role === 'menuitem' ? 40 : 0)
        + (lineCount(el) === 1 ? 120 : 0)
        - txt.length / 5
        - lineCount(el) * 80
        - el.querySelectorAll('*').length;
    };
    const clickSelector = '.lv_new_third_part_sign_in_expand-button,.login-button-CK3g2c,button,a,[role=button],[role=menuitem]';
    const candidates = [...document.querySelectorAll('button,a,[role=button],[role=menuitem],div,span')]
      .filter(el => visible(el) && re.test(textOf(el)))
      .map(el => {
        // If a large modal/container matches because its text includes every
        // login method, never blindly pick its first child (usually Google).
        // Prefer the smallest clickable descendant whose own text also matches.
        const matchingChildren = [...(el.querySelectorAll?.(clickSelector) || [])].filter(c => visible(c) && re.test(textOf(c)));
        const child = matchingChildren.sort((a, b) => score(b) - score(a))[0];
        const closest = el.closest(clickSelector);
        const clickable = child || (closest && re.test(textOf(closest)) ? closest : null) || el;
        return clickable;
      })
      .filter((el, idx, arr) => arr.indexOf(el) === idx)
      .sort((a, b) => score(b) - score(a));
    const el = candidates[0];
    if (!el) return null;
    // 先滚动，坐标在下一次调用里再取，避免平滑滚动未结束导致坐标失效。
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    // Input.dispatchMouseEvent 使用顶层 viewport 坐标；若元素位于 iframe 中，
    // getBoundingClientRect 返回的是 iframe 内部坐标，必须叠加各层 iframe 的偏移。
    let offsetX = 0, offsetY = 0, w = window, guard = 0;
    while (w !== w.parent && guard++ < 10) {
      try {
        const fr = w.frameElement;
        if (!fr) break;
        const fb = fr.getBoundingClientRect();
        offsetX += fb.left; offsetY += fb.top;
        w = w.parent;
      } catch { break; }
    }
    return {
      x: r.left + r.width / 2 + offsetX,
      y: r.top + r.height / 2 + offsetY,
      w: r.width, h: r.height,
      inFrame: offsetX !== 0 || offsetY !== 0,
      text: textOf(el).slice(0, 120), tag: el.tagName,
      role: el.getAttribute('role'), cls: String(el.className || '').slice(0, 120)
    };
  })()`;
  const params: any = { expression, returnByValue: true, awaitPromise: true };
  if (typeof contextId === 'number') params.contextId = contextId;
  const result = await cdpCall(ws, 'Runtime.evaluate', params, 15000);
  const target = result?.result?.value;
  if (!target || typeof target.x !== 'number' || typeof target.y !== 'number') return false;
  if (!(target.w > 0 && target.h > 0)) {
    logger.warn(`CDP 点击目标尺寸为 0，跳过点击: ${target.text} (${target.tag})`);
    return false;
  }
  logger.info(`CDP 点击文本: ${target.text} (${target.tag}${target.role ? '/' + target.role : ''}) at ${Math.round(target.x)},${Math.round(target.y)}${target.inFrame ? ' [iframe]' : ''}`);
  await cdpCall(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, button: 'none' }, 5000);
  await cdpCall(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 }, 5000);
  await cdpCall(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 }, 5000);

  // Dispatch one trusted click. A second synthetic click can run after React
  // has opened the next dialog and reset the flow back to method selection.
  return true;
}


const PASS_INPUT_FN = `i => i.type === 'password' || /password|passwd|pwd|密码|密碼|mật khẩu|mat khau/i.test([i.name,i.id,i.placeholder,i.autocomplete].join(' '))`;

type DreaminaLoginField = { type?: string; name?: string; id?: string; placeholder?: string; autocomplete?: string };

export function classifyDreaminaCredentialFields(fields: DreaminaLoginField[]): { userIndex: number; passwordIndex: number } {
  const value = (field: DreaminaLoginField) => [field.type, field.name, field.id, field.placeholder, field.autocomplete].join(' ');
  const passwordIndex = fields.findIndex(field => field.type === 'password'
    || /password|passwd|pwd|密码|密碼|mật khẩu|mat khau/i.test(value(field)));
  const userPattern = /email|e-mail|mail|user|account|phone|mobile|login|correo|メール|이메일|邮箱|郵箱|電郵|账号|帳號|tài khoản|tai khoan/i;
  const userIndex = fields.findIndex((field, index) => index !== passwordIndex
    && (field.type === 'email' || field.type === 'tel' || userPattern.test(value(field))));
  return { userIndex, passwordIndex };
}

/**
 * 邮箱框只在同一表单/弹窗里存在密码框时才认定，避免匹配到首页的搜索框或提示词框。
 * 之前的松散正则在首页就能命中 input，导致把账号填进生成提示框。
 */
/**
 * 判定登录表单是否已就绪。Dreamina 是两步式：第一步弹窗只有邮箱框，密码框要提交后才出现，
 * 所以"只有邮箱框"也算已进入表单，不能再去点登录方式选择按钮（会重置弹窗）。
 * 同时要求该输入框位于登录弹窗/表单内，避免把首页提示词框当成登录表单。
 */
const CREDENTIAL_FIELDS_EXPR = `(() => {
  const visible = ${VISIBLE_FN};
  const classify = (${classifyDreaminaCredentialFields.toString()});
  const inputs = [...document.querySelectorAll('input')].filter(visible);
  const LOGIN_SCOPE_SEL = 'form,[role=dialog],[class*=modal],[class*=login],[class*=sign],[class*=Login],[class*=Sign]';
  const scoped = inputs.filter(i => i.closest(LOGIN_SCOPE_SEL));
  return scoped.some(input => {
    const scope = input.closest(LOGIN_SCOPE_SEL);
    const pool = scoped.filter(candidate => candidate.closest(LOGIN_SCOPE_SEL) === scope);
    const result = classify(pool.map(i => ({ type:i.type, name:i.name, id:i.id, placeholder:i.placeholder, autocomplete:i.autocomplete })));
    return result.userIndex >= 0 || result.passwordIndex >= 0;
  });
})()`;

/** 返回承载邮箱/密码表单的 contextId；undefined 表示主 frame 或未找到。 */
async function findCredentialContextId(ws: WebSocket): Promise<number | undefined> {
  return await findContextIdWhere(ws, CREDENTIAL_FIELDS_EXPR);
}

async function hasDreaminaCredentialFields(ws: WebSocket, contextId?: number): Promise<boolean> {
  return await evalOnPage<boolean>(ws, CREDENTIAL_FIELDS_EXPR, 15000, contextId);
}

async function getPageSnapshot(ws: WebSocket, limit = 3000): Promise<{ url: string; title: string; text: string; cookies: string; ua: string }> {
  const info = await evalOnPage<any>(ws, `JSON.stringify({
    url: location.href,
    title: document.title,
    text: document.body ? document.body.innerText.slice(0, ${limit}) : '',
    cookies: document.cookie,
    ua: navigator.userAgent
  })`, 20000);
  return JSON.parse(info || "{}");
}

async function handleDreaminaPostSubmitRecovery(ws: WebSocket): Promise<boolean> {
  // Dreamina occasionally completes the account login server-side but leaves an
  // error modal in the browser (Traditional Chinese: 發生錯誤 / 重新整理頁面並重試).
  // A real click on the modal refresh/retry button reveals the already-created
  // session cookies. Handle this generically for imported accounts/locales.
  const snapshot = await getPageSnapshot(ws, 2500).catch(() => null);
  const text = String(snapshot?.text || '');
  if (!/(發生錯誤|发生错误|something went wrong|error occurred|重新整理|刷新|重試|重试|retry|refresh)/i.test(text)) {
    return false;
  }

  logger.warn('Dreamina 登录后出现错误/刷新提示，尝试点击重新整理/重试后再次检测登录态');
  const clicked = await clickTextByCdp(ws, '重新整理|刷新|重試|重试|retry|refresh|try again').catch(() => false);
  if (!clicked) {
    await cdpCall(ws, 'Page.reload', { ignoreCache: false }, 10000).catch(() => null);
  }
  await new Promise(r => setTimeout(r, Number(process.env.DREAMINA_LOGIN_RECOVERY_WAIT_MS || 25000)));
  return true;
}

export async function checkDreaminaLoginByCdp(cdpPort: number, cdpWsUrl?: string | null): Promise<DreaminaLoginResult> {
  // Dreamina replaces the page target during navigation/login. Rediscover it
  // first so a persisted URL does not point at a closed target or old port.
  let wsUrl = '';
  try {
    const tabs = await getCdpTargets(cdpPort, 5000);
    const pages = tabs.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
    // The auth flow can briefly move from Dreamina to a CapCut identity page.
    // Prefer those known first-party pages before falling back to any usable
    // non-blank tab; otherwise a stale saved websocket can make check-login
    // report a false failure after a successful redirect.
    // A QR flow opens a second Dreamina target. Prefer it while the user is
    // still completing the scan so the checker reports the actionable state
    // instead of looking at the stale home tab.
    const page = pages.find(t => /\/scan-qr-code(?:[/?]|$)/i.test(String(t.url || '')))
      || pages.find(t => String(t.url || '').includes('dreamina.capcut.com'))
      || pages.find(t => /(?:^|[/:.])capcut\.com(?:\/|$)/i.test(String(t.url || '')))
      || pages.find(t => !/^(?:about:blank|chrome|devtools):/i.test(String(t.url || '')))
      || (!cdpWsUrl ? pages[0] : undefined);
    if (page?.webSocketDebuggerUrl) wsUrl = rewriteCdpWsUrl(page.webSocketDebuggerUrl, cdpPort);
  } catch (e: any) {
    logger.debug('Dreamina 登录检测重新发现页面失败，将回退已保存 CDP: ' + (e?.message || e));
  }
  if (!wsUrl && cdpWsUrl) {
    try { wsUrl = rewriteCdpWsUrl(cdpWsUrl, cdpPort); } catch { wsUrl = cdpWsUrl; }
  }
  if (!wsUrl) wsUrl = await waitForPageWs(cdpPort, 15000);
  const ws = new WebSocket(wsUrl);
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: DreaminaLoginResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Detach handlers before closing so cleanup's close event cannot settle
      // the promise a second time.
      ws.onopen = null;
      ws.onerror = null;
      ws.onclose = null;
      try { ws.close(); } catch {}
      if (error) reject(error);
      else resolve(result as DreaminaLoginResult);
    };
    const timer = setTimeout(() => finish(new Error("check login timeout")), 30000);
    ws.onopen = async () => {
      try {
        if (settled) return;
        const parsed = await getPageSnapshot(ws, 3000);
        await cdpCall(ws, "Network.enable", {}, 10000).catch(() => null);
        const cookies = await cdpCall(ws, "Network.getAllCookies", {}, 15000).catch(() => null);
        const cookieHeader = cookieHeaderFromCdp(cookies?.cookies || []);
        let docCookie = '';
        // document.cookie has no domain/expiry metadata. Use it only on a
        // first-party page, and only as a fallback when the CDP cookie jar is
        // unavailable or unexpectedly empty (some remote CDP proxies return
        // `{ cookies: [] }` for an otherwise valid page).
        if (!cookies || !Array.isArray(cookies.cookies) || cookies.cookies.length === 0) {
          try {
            if (isCapcutDomain(new URL(parsed.url).hostname)) docCookie = String(parsed.cookies || '');
          } catch {}
        }
        const authCookieNames = new Set(['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard']);
        const hasAuthCookie = (name: any, value: any) => authCookieNames.has(String(name || '').toLowerCase()) && String(value ?? '').trim() !== '';
        const loggedIn = (cookieHeader || docCookie).split(';').some(part => {
            const [name, ...rest] = String(part).trim().split('=');
            return hasAuthCookie(name, rest.join('='));
          });
        const pageUrl = String(parsed.url || '');
        const pageText = String(parsed.text || '');
        const qrLogin = /(?:scan[-_ ]?qr|qr[-_ ]?code|capcut mobile|扫描二维码|掃描二維碼|扫码|掃碼)/i.test(`${pageUrl} ${pageText}`);
        const verification = /(verify|verification|verification code|security code|one[- ]time password|otp|captcha|验证码|安全验证|二次验证|兩步驗證|驗證碼|認証コード|確認コード|인증 코드|인증번호)/i.test(pageText);
        const methodChooser = /continue with (google|apple|facebook|tiktok|capcut mobile)|continue.*(?:email|e-mail|mail)|使用.*(?:Google|Apple|Facebook|TikTok|电子邮件|邮箱|電郵)|繼續.*(?:Google|Apple|Facebook|TikTok|電子郵件|電郵)|继续.*(?:Google|Apple|Facebook|TikTok|电子邮件|邮箱)|登录方式|登入方式|登录 Dreamina|登入 Dreamina/i.test(pageText);
        const status = loggedIn ? "ok" : (qrLogin || verification) ? "need_2fa" : "failed";
        const message = loggedIn ? undefined
          : qrLogin ? '当前为二维码登录，请在 BitBrowser 中使用 CapCut App 扫码后点击“继续检测”'
          : verification ? '检测到验证码或二次验证，请在 BitBrowser 中完成后点击“继续检测”'
          : methodChooser ? '当前仍停留在登录方式选择页，请选择邮箱、第三方账号或二维码方式完成登录'
          : undefined;
        finish(undefined, {
          status,
          message,
          cookies: cookieHeader || docCookie,
          cdpPort,
          cdpWsUrl: wsUrl,
          userAgent: parsed.ua
        });
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)));
      }
    };
    ws.onerror = () => finish(new Error("CDP websocket error"));
    ws.onclose = () => finish(new Error("CDP connection closed"));
  });
}

export async function loginDreaminaViaBitBrowser(options: {
  bitbrowserProfileId: string;
  proxyUrl?: string;
  username?: string;
  password?: string;
  loginUrl?: string;
  onOpened?: (runtime: { cdpPort: number; cdpWsUrl?: string; userAgent?: string }) => void | Promise<void>;
  onProgress?: (message: string) => void | Promise<void>;
}): Promise<DreaminaLoginResult> {
  const client = new BitBrowserClient();
  let automationTimedOut = false;
  let automationSettled = false;
  const automationActive = () => !automationTimedOut && !automationSettled;
  const reportProgress = async (message: string) => {
    if (!automationActive()) return;
    try { await options.onProgress?.(message); }
    catch (e: any) { logger.warn(`Dreamina 登录进度回调失败: ${e?.message || e}`); }
  };
  logger.info(`打开 BitBrowser profile: ${options.bitbrowserProfileId}`);
  await reportProgress('正在打开 BitBrowser');
  const opened = await client.openForAccount(options.bitbrowserProfileId, { proxy_url: options.proxyUrl }, reportProgress);
  if (!opened.cdpPort) throw new Error("BitBrowser open did not return CDP port");

  const openedWs = opened.ws && opened.ws.includes('/devtools/page/')
    ? rewriteCdpWsUrl(opened.ws, opened.cdpPort)
    : undefined;
  try {
    await options.onOpened?.({ cdpPort: opened.cdpPort, cdpWsUrl: openedWs, userAgent: undefined });
  } catch (e: any) {
    logger.warn(`Dreamina 登录打开回调失败: ${e?.message || e}`);
  }
  await reportProgress('正在连接 CDP');
  let targetWs = '';
  try {
    targetWs = await waitForAnyPageWs(opened.cdpPort, 60000);
  } catch (e: any) {
    if (!openedWs) throw e;
    logger.warn(`CDP 页面重新发现失败，回退 /browser/open 返回的页面: ${e?.message || e}`);
    targetWs = openedWs;
  }
  try {
    await options.onOpened?.({ cdpPort: opened.cdpPort, cdpWsUrl: targetWs, userAgent: undefined });
  } catch (e: any) {
    logger.warn(`Dreamina 登录页面回调失败: ${e?.message || e}`);
  }
  let ws = new WebSocket(targetWs);
  const refreshPage = async (): Promise<WebSocket> => {
    if (!automationActive()) throw new Error('Dreamina login automation is no longer active');
    const currentTarget = await waitForAnyPageWs(opened.cdpPort!, 15000);
    if (!automationActive()) throw new Error('Dreamina login automation is no longer active');
    if (currentTarget === targetWs && ws.readyState === WebSocket.OPEN) return ws;
    const previous = ws;
    const replacement = await connectPageWebSocket(currentTarget);
    if (!automationActive()) {
      try { replacement.close(); } catch {}
      throw new Error('Dreamina login automation is no longer active');
    }
    previous.on('error', () => {});
    previous.onerror = null;
    previous.onclose = null;
    ws = replacement;
    targetWs = currentTarget;
    ws.onclose = () => automationFinish?.(new Error('CDP connection closed'));
    ws.onerror = () => automationFinish?.(new Error('CDP websocket error'));
    try { previous.close(); } catch {}
    try {
      await options.onOpened?.({ cdpPort: opened.cdpPort!, cdpWsUrl: targetWs });
    } catch (e: any) { logger.warn(`Dreamina 登录页面回调失败: ${e?.message || e}`); }
    return ws;
  };
  // 自动填表的诊断结果需要在 Promise 之外可见，以便写入登录状态提示。
  let fillOutcome: any = null;
  let automationFinish: ((error?: Error) => void) | null = null;

  const automationResult = await new Promise<DreaminaLoginResult>((resolve, reject) => {
    const finish = (error?: Error, result?: DreaminaLoginResult) => {
      if (automationSettled) return;
      automationSettled = true;
      clearTimeout(timer);
      ws.onopen = null;
      ws.onerror = null;
      ws.onclose = null;
      try { ws.close(); } catch {}
      if (error) reject(error);
      else resolve(result as DreaminaLoginResult);
    };
    automationFinish = finish;
    const timer = setTimeout(() => {
      automationTimedOut = true;
      finish(new Error("Dreamina login automation timeout"));
    }, 120000);
    ws.onopen = async () => {
      try {
        if (!automationActive()) return;
        await reportProgress('正在打开 Dreamina');
        ws = await navigateAndWait(ws, getDreaminaLoginUrl(options.loginUrl), refreshPage);
        if (!automationActive()) return;

        await reportProgress('正在检测登录状态');
        const before = await checkDreaminaLoginByCdp(opened.cdpPort!, targetWs).catch(() => null);
        if (!automationActive()) return;
        if (before?.status === "ok") {
          // Keep the already-confirmed session result intact.  Resolving the
          // detached promise without a value makes the dashboard route read
          // `result.cdpPort` from undefined and mark a perfectly valid
          // existing session as failed.
          return finish(undefined, {
            status: 'ok',
            message: before.message,
            cookies: before.cookies,
            cdpPort: before.cdpPort || opened.cdpPort,
            cdpWsUrl: before.cdpWsUrl || targetWs,
            userAgent: before.userAgent,
          } as any);
        }

        if (options.username && options.password) {
          if (!automationActive()) return;
          await refreshPage();
          await reportProgress('正在填写登录表单');
          logger.info(`尝试自动填写 Dreamina 登录表单: ${mask(options.username)}`);
          // Prefer real CDP mouse clicks for the login dialog. Dreamina often ignores
          // synthetic DOM click events on these login controls. If the credential
          // form is already visible, do not click the login-method chooser again;
          // doing so can reset the modal back to the method selection page.
          const EMAIL_OPTION_RE = 'continue.*(email|e-mail|mail|電子郵件|电子邮件|電郵|邮箱|郵箱|メール|이메일|correo)|email.*continue|use.*(email|e-mail|mail)|使用.*(電子郵件|电子邮件|電郵|邮箱|郵箱)|繼續.*(電子郵件|电邮|邮箱|郵箱)|继续.*(电子邮件|邮箱)|tiếp tục bằng email|tiep tuc bang email|email|e-mail|電子郵件|电子邮件|電郵|邮箱|郵箱|メール|이메일|correo';

          // 登录弹窗可能在 iframe 内：先在所有 execution context 里找凭据表单。
          let credCtx = await findCredentialContextId(ws).catch(() => undefined);
          const alreadyAtCredentialForm = credCtx !== undefined
            || await hasDreaminaCredentialFields(ws).catch(() => false);

          if (!alreadyAtCredentialForm) {
            // 登录方式选择按钮同样可能在 iframe 内，逐个 context 尝试点击。
            const clickInAnyContext = async (pattern: string): Promise<boolean> => {
              for (const ctx of await collectExecutionContexts(ws)) {
                if (!automationActive()) return false;
                if (await clickTextByCdp(ws, pattern, 'i', ctx).catch(() => false)) return true;
              }
              return false;
            };

            // 分阶段推进，每步验证是否已出现凭据表单，避免在首页空点或重复点击重置弹窗。
            // 阶段一：页面可能仍是未登录首页（日志实测文本为 "Sign in to start creating"），
            // 需要先打开登录弹窗；?need_login=true 并不保证弹窗自动弹出。
            // The unauthenticated Dreamina home uses a CTA such as
            // "Sign in to start creating" rather than a bare "Sign in".
            // Keep the match anchored so we do not click unrelated copy, but
            // allow the CTA suffix (and its localized equivalents) to open
            // the login dialog before looking for the email method.
            const SIGN_IN_RE = '^\\s*(sign in|sign up|log in|login|登录|登入|登錄|đăng nhập|dang nhap|iniciar sesión|se connecter|connexion|ログイン|로그인|masuk|เข้าสู่ระบบ)(?:\\s+(?:to\\s+(?:start\\s+creating|create|claim|continue)|now))?\\s*$';
            const CLAIM_SIGN_IN_RE = '^\\s*sign in to claim\\s*$';
            for (const stage of [SIGN_IN_RE, CLAIM_SIGN_IN_RE, EMAIL_OPTION_RE] as const) {
              if (!automationActive()) return;
              await refreshPage();
              credCtx = await findCredentialContextId(ws).catch(() => undefined);
              if (credCtx !== undefined) break;
              const clicked = await clickInAnyContext(stage);
              logger.info(`Dreamina 登录阶段点击 ${clicked ? '成功' : '未命中'}: ${stage === SIGN_IN_RE ? 'Sign in' : 'Continue with email'}`);
              await new Promise(r => setTimeout(r, 3000));
            }
            // 弹窗切换后表单可能落在新的 iframe context，重新定位。
            credCtx = await findCredentialContextId(ws).catch(() => undefined);
            if (credCtx === undefined && !await hasDreaminaCredentialFields(ws).catch(() => false)) {
              logger.warn('Dreamina 登录弹窗未出现邮箱/密码表单，将继续尝试填表并输出页面诊断信息');
            }
          } else {
            logger.info(`Dreamina 已在邮箱/密码表单，跳过登录方式选择点击${credCtx !== undefined ? ` (iframe context ${credCtx})` : ''}`);
          }
          try {
            const fillResult = await evalOnPage<any>(ws, `
(async()=>{
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = ${VISIBLE_FN};
  const textOf = el => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
  const clickLike = el => {
    if (!el) return false;
    el.scrollIntoView({block:'center', inline:'center'});
    const r = el.getBoundingClientRect();
    const opts = {bubbles:true, cancelable:true, clientX:r.left+r.width/2, clientY:r.top+r.height/2};
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    return true;
  };
  const byText = (re) => {
    const lineCount = el => textOf(el).split(String.fromCharCode(10)).filter(Boolean).length;
    const score = el => {
      const cls = String(el.className || '');
      const role = el.getAttribute('role') || '';
      const txt = textOf(el);
      return (el.matches('button,a,[role=button],[role=menuitem]') ? 100 : 0)
        + (/lv_new_third_part_sign_in_expand-button|login-button/i.test(cls) ? 200 : 0)
        + (/lv_new_third_part_sign_in_expand-wrapper/i.test(cls) ? 60 : 0)
        + (role === 'menuitem' ? 30 : 0)
        + (lineCount(el) === 1 ? 100 : 0)
        - txt.length / 10
        - lineCount(el) * 60
        - el.querySelectorAll('*').length;
    };
    const clickSelector = '.lv_new_third_part_sign_in_expand-button,.login-button-CK3g2c,button,a,[role=button],[role=menuitem]';
    return [...document.querySelectorAll('button,a,[role=button],[role=menuitem],div,span')]
      .filter(el => visible(el) && re.test(textOf(el)))
      .map(el => {
        const matchingChildren = [...(el.querySelectorAll?.(clickSelector) || [])].filter(c => visible(c) && re.test(textOf(c)));
        return matchingChildren.sort((a, b) => score(b) - score(a))[0] || (el.closest(clickSelector) && re.test(textOf(el.closest(clickSelector))) ? el.closest(clickSelector) : null) || el;
      })
      .filter((el, idx, arr) => arr.indexOf(el) === idx)
      .sort((a, b) => score(b) - score(a))[0];
  };
  const setValue = (el, value) => {
    if (!el) return false;
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new InputEvent('input',{bubbles:true, inputType:'insertText', data:String(value)}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  };
  const classify = (${classifyDreaminaCredentialFields.toString()});
  const isPass = ${PASS_INPUT_FN};
  // 账号框必须落在登录弹窗/表单范围内，避免误取首页提示词框（实测 hasUser 曾在首页误判为 true）。
  const LOGIN_SCOPE_SEL = 'form,[role=dialog],[class*=modal],[class*=login],[class*=sign],[class*=Login],[class*=Sign]';
  const findCredentialFields = () => {
    const inputs = [...document.querySelectorAll('input')].filter(visible);
    const scoped = inputs.filter(i => i.closest(LOGIN_SCOPE_SEL));
    const anchor = scoped.find(i => isPass(i) || i.type === 'email' || i.type === 'tel'
      || /email|e-mail|mail|user|account|phone|mobile|login|correo|メール|이메일|邮箱|郵箱|電郵|账号|帳號|tài khoản|tai khoan/i.test([i.name,i.id,i.placeholder,i.autocomplete].join(' ')));
    const scope = anchor?.closest(LOGIN_SCOPE_SEL);
    if (!scope) return { user: null, pass: null };
    const pool = scoped.filter(i => i.closest(LOGIN_SCOPE_SEL) === scope);
    const result = classify(pool.map(i => ({ type:i.type, name:i.name, id:i.id, placeholder:i.placeholder, autocomplete:i.autocomplete })));
    return {
      user: result.userIndex >= 0 ? pool[result.userIndex] : null,
      pass: result.passwordIndex >= 0 ? pool[result.passwordIndex] : null,
    };
  };
  const findPass = () => findCredentialFields().pass;
  const findUser = () => findCredentialFields().user;
  const submitRe = /^(log in|sign in|login|continue|next|submit|proceed|verify|send code|get code|登录|登入|登錄|繼續|继续|下一步|tiếp tục|tiep tuc|kế tiếp|ke tiep|đăng nhập|dang nhap|continuar|siguiente|iniciar sesión|se connecter|continuer|進む|続行|次へ|ログイン|계속|다음|로그인|lanjutkan|masuk|ดำเนินการต่อ|เข้าสู่ระบบ|entrar|iniciar sessão)$/i;
  // 从输入框向上逐层查找最近的提交按钮，绝不退化为全文档搜索。
  // 全文档搜索会命中页面右上角的全局 "Sign in"（DOM 顺序早于弹窗），
  // 点击它等于重新打开登录弹窗，导致流程退回登录方式选择页。
  const findSubmit = (anchor) => {
    if (!anchor) return null;
    let el = anchor.parentElement, guard = 0;
    while (el && el !== document.body && guard++ < 12) {
      const btns = [...el.querySelectorAll('button,[role=button],[type=submit]')]
        .filter(visible)
        .filter(b => !b.disabled && submitRe.test(textOf(b)));
      if (btns.length) return btns[btns.length - 1];
      el = el.parentElement;
    }
    return null;
  };

  // Dreamina/CapCut 采用两步式邮箱登录（实测截图确认）：
  // 第一步弹窗只有 "Enter email" + Continue，提交后密码框才渲染出来。
  // 因此不能要求邮箱框和密码框同时存在，否则流程会在第一步死锁。
  const trace = [];
  let user = findUser();
  let pass = findPass();

  if (!user && !pass) {
    const emailOption = byText(/continue.*(email|e-mail|mail|電子郵件|电子邮件|電郵|邮箱|郵箱|メール|이메일|correo)|email.*continue|use.*(email|e-mail|mail)|tiếp tục bằng email|tiep tuc bang email|繼續.*(電子郵件|电邮|邮箱|郵箱)|继续.*(电子邮件|邮箱)|使用.*(電子郵件|电子邮件|電郵|郵箱|邮箱)|^\s*(email|e-mail|電子郵件|电子邮件|電郵|邮箱|郵箱|メール|이메일)\s*$/i);
    if (emailOption) { clickLike(emailOption); trace.push('clicked-email-option'); await sleep(3000); }
    user = findUser();
    pass = findPass();
  }

  let userSet = false, passSet = false, submitted = false, emailStepSubmitted = false;

  // 第一步：填邮箱并提交（密码框尚未出现时）
  if (user && !pass) {
    userSet = setValue(user, ${JSON.stringify(options.username)});
    trace.push('filled-email');
    await sleep(600);
    const next = findSubmit(user);
    if (next) {
      clickLike(next);
      emailStepSubmitted = true;
      submitted = true;
      trace.push('submitted-email-step:' + textOf(next).slice(0, 30));
    } else {
      trace.push('email-step-submit-not-found');
    }
    // 等待密码框渲染（可能伴随弹窗内容替换或验证码）
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      pass = findPass();
      if (pass) { trace.push('password-field-appeared-after-' + (i + 1) + 's'); break; }
    }
  }

  // 第二步：填密码并提交
  if (pass) {
    const u = findUser();
    // 第二步页面若仍带邮箱框且为空，补填一次（部分实现会保留该字段）。
    if (u && !u.value) { userSet = setValue(u, ${JSON.stringify(options.username)}) || userSet; await sleep(400); }
    passSet = setValue(pass, ${JSON.stringify(options.password)});
    trace.push('filled-password');
    await sleep(800);
    const submit = findSubmit(pass);
    if (submit) { clickLike(submit); submitted = true; trace.push('submitted-password-step:' + textOf(submit).slice(0, 30)); }
    else trace.push('password-step-submit-not-found');

    // 校验提交结果：若弹窗退回登录方式选择页（出现 Continue with Google/Facebook/TikTok），
    // 说明点到的是全局 Sign in 而非表单内提交按钮，需要明确报出而不是静默成功。
    if (submitted) {
      for (let i = 0; i < 8; i++) {
        await sleep(1000);
        const t = document.body?.innerText || '';
        const backToChooser = /continue with (google|facebook|tiktok|capcut mobile)/i.test(t);
        if (backToChooser) { trace.push('regressed-to-method-chooser-after-' + (i + 1) + 's'); break; }
        if (!findPass()) { trace.push('password-form-closed-after-' + (i + 1) + 's'); break; }
      }
    }
  }

  const hasUser = !!findUser() || userSet;
  const hasPass = !!pass;
  const regressed = trace.some(t => t.startsWith('regressed-to-method-chooser'));
  return {
    userSet, passSet, hasUser, hasPass, submitted, emailStepSubmitted, trace,
    reason: regressed ? 'regressed-to-method-chooser'
      : (!hasUser && !hasPass) ? 'credential-form-not-found'
      : (!hasPass ? 'password-step-not-reached' : ''),
    inputs: [...document.querySelectorAll('input')].filter(visible).map(i => ({ type: i.type, name: i.name, id: i.id, ph: i.placeholder })).slice(0, 10),
    url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 1200)
  };
})()`, 45000, credCtx);
            // 之前这里丢弃了返回值，导致"表单没找到"和"填了没提交"在日志里无法区分。
            fillOutcome = fillResult || null;
            if (fillOutcome) {
              logger.info(`Dreamina 自动填表结果: hasUser=${fillOutcome.hasUser} hasPass=${fillOutcome.hasPass} userSet=${fillOutcome.userSet} passSet=${fillOutcome.passSet} submitted=${fillOutcome.submitted} 步骤=[${(fillOutcome.trace || []).join(' -> ')}] url=${fillOutcome.url}`);
              if (fillOutcome.reason === 'regressed-to-method-chooser') {
                logger.warn('Dreamina 提交后退回登录方式选择页，说明点击的按钮不在凭据表单内或凭据被拒绝。请确认账号密码是否正确');
              } else if (fillOutcome.reason === 'password-step-not-reached') {
                logger.warn(`Dreamina 邮箱已提交但密码框未出现（可能触发验证码或需邮箱验证码登录）。可见 input: ${JSON.stringify(fillOutcome.inputs || [])}`);
                logger.warn(`Dreamina 页面文本片段: ${String(fillOutcome.text || '').replace(/\s+/g, ' ').slice(0, 300)}`);
              } else if (!fillOutcome.hasUser && !fillOutcome.hasPass) {
                logger.warn(`Dreamina 未找到邮箱/密码输入框${credCtx !== undefined ? ` (context ${credCtx})` : ' (主 frame)'}，已跳过填写避免误填。可见 input: ${JSON.stringify(fillOutcome.inputs || [])}`);
                logger.warn(`Dreamina 页面文本片段: ${String(fillOutcome.text || '').replace(/\s+/g, ' ').slice(0, 300)}`);
              } else if (!fillOutcome.submitted) {
                logger.warn('Dreamina 已填入邮箱/密码但未找到可点击的提交按钮，请在 BitBrowser 中手动提交后点击"检测"');
              }
            }
          } catch (e) {
            // Clicking login/submit can navigate the page and make the Runtime.evaluate
            // response disappear. Do not fail the whole login flow; keep the browser
            // open so the user can finish captcha/2FA/manual login and then click 检测.
            logger.warn(`Dreamina 自动填表未确认完成: ${e.message || e}`);
          }
          if (!automationActive()) return;
          await reportProgress('等待验证码或二次验证');
          await new Promise(r => setTimeout(r, Number(process.env.DREAMINA_LOGIN_SETTLE_MS || 30000)));
          if (!automationActive()) return;
          await reportProgress('正在保存登录状态');
          await refreshPage();
          if (!automationActive()) return;
          await handleDreaminaPostSubmitRecovery(ws).catch(e => logger.warn(`Dreamina 登录恢复处理失败: ${e.message || e}`));
        }

        // This only means the browser automation phase completed. The caller
        // performs a fresh cookie check below before declaring the login valid.
        finish(undefined, { status: 'failed', message: '' });
      } catch (e) {
        if (automationActive()) finish(e instanceof Error ? e : new Error(String(e)));
      }
    };
    ws.onerror = () => finish(new Error("CDP websocket error"));
    ws.onclose = () => finish(new Error("CDP connection closed"));
  });

  // An already authenticated profile is verified by the preflight check and
  // carries its cookie snapshot. Return it directly so a second target scan
  // cannot accidentally inspect an old/blank tab and overwrite success.
  if (automationResult.status === 'ok' && automationResult.cookies) return automationResult;

  // The login click may navigate or replace the page target; rediscover the current
  // Dreamina page instead of reusing a possibly stale WebSocket URL.
  const finalResult = await checkDreaminaLoginByCdp(opened.cdpPort);

  // 登录未成功时，把自动填表的实际卡点带回后台，避免只显示"登录未确认"。
  if (finalResult.status !== 'ok' && !finalResult.message && options.username && options.password) {
    if (!fillOutcome) {
      finalResult.message = '自动填表未返回结果（页面可能已跳转），请在 BitBrowser 中确认后点击“检测”';
    } else if (fillOutcome.reason === 'regressed-to-method-chooser') {
      finalResult.message = '提交后退回登录方式选择页，可能是账号密码错误或被拒绝，请核对凭据';
    } else if (fillOutcome.reason === 'password-step-not-reached') {
      finalResult.message = '邮箱已提交但密码框未出现，可能需要邮箱验证码，请在 BitBrowser 中人工完成';
    } else if (!fillOutcome.hasUser || !fillOutcome.hasPass) {
      finalResult.message = '未找到邮箱/密码输入框，登录弹窗结构可能已变化或仍停留在登录方式选择页';
    } else if (!fillOutcome.submitted) {
      finalResult.message = '已填入邮箱/密码但未找到提交按钮，请在 BitBrowser 中手动提交';
    } else {
      finalResult.message = '已提交登录但未检测到会话 cookie，可能需要人工完成验证码/二次验证';
    }
  }
  return finalResult;
}

export default BitBrowserClient;
