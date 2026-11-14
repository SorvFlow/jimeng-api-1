import _ from 'lodash';
import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import Exception from '@/lib/exceptions/Exception.ts';
import EX from '@/lib/consts/exceptions.ts';
import HTTP_STATUS_CODES from '@/lib/http-status-codes.ts';
import db from '@/lib/database.ts';
import { getCredit, request as jimengRequest } from '@/api/controllers/core.ts';
import { triggerHealthCheck, triggerCreditsSync } from '@/lib/account-keeper.ts';
import BitBrowserClient, { checkDreaminaLoginByCdp, discoverRunningDreaminaContext, loginDreaminaViaBitBrowser } from '@/lib/bitbrowser.ts';

const loginTasks = new Set<number>();

/**
 * Extract the Dreamina session token from a browser Cookie header.
 *
 * Depending on the account/region and the identity service response, the
 * browser may expose any of `sessionid`, `sessionid_ss`, `sid_tt`, or only
 * `sid_guard`.  The first three carry the token directly; `sid_guard` stores
 * it as the first `|`-separated field (usually URI encoded as `%7C`).
 */
function extractDreaminaSessionToken(cookieHeader?: string | null): string | null {
  const values = new Map<string, string>();
  for (const part of String(cookieHeader || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim().toLowerCase();
    const value = part.slice(separator + 1).trim();
    if (name && value && !values.has(name)) values.set(name, value);
  }

  for (const name of ['sessionid', 'sessionid_ss', 'sid_tt']) {
    const value = values.get(name);
    if (value) return value;
  }

  const sidGuard = values.get('sid_guard');
  if (sidGuard) {
    let decoded = sidGuard;
    try { decoded = decodeURIComponent(sidGuard); } catch { /* keep raw value */ }
    const token = decoded.split('|')[0].trim();
    if (token) return token;
  }
  return null;
}

// 验证登录状态的辅助函数
function getSessionUserId(request: Request): number | null {
  const sessionId = request.headers.cookie?.match(/session=([^;]+)/)?.[1];
  if (!sessionId) return null;
  return db.validateSession(sessionId);
}

function requireAuth(request: Request): number {
  const userId = getSessionUserId(request);
  if (!userId) {
    throw new Exception(EX.SYSTEM_UNAUTHORIZED).setHTTPStatusCode(HTTP_STATUS_CODES.UNAUTHORIZED);
  }
  return userId;
}

// Keep login progress compatible with databases created before the progress
// columns/functions were introduced. The fallback still exposes the phase in
// last_login_error while the normal path stores structured progress fields.
function updateLoginProgress(accountId: number, message: string, progress?: any): void {
  const update = (db as any).updateAccountLoginProgress;
  if (typeof update === 'function') {
    update(accountId, message, progress);
  } else {
    db.updateAccountLoginStatus(accountId, 'logging_in', message || '登录处理中');
  }
}

function formatBitBrowserOperationError(action: string, error: any, fallbackHint = ''): string {
  const raw = String(error?.message || error || '未知错误').trim();
  if (/dynamicIpUrl|提取URL/i.test(raw)) {
    return `${action}失败：BitBrowser Profile 代理配置不完整（缺少动态提取 URL：dynamicIpUrl）：${raw}。请在 BitBrowser 中将该 Profile 改为直连/静态代理，或填写代理商提供的动态提取 URL 后再重试`;
  }
  return `${action}失败：${raw}${fallbackHint ? `；${fallbackHint}` : ''}`;
}


function parseLoginAccountLines(raw: string): any[] {
  return String(raw || '').split(/\n+/).map((line) => {
    line = line.trim();
    if (!line) return null;
    const sep = line.includes('----') ? '----' : line.includes('|') ? '|' : ',';
    const parts = line.split(sep);
    const username = String(parts[0] || '').trim();
    const password = parts.slice(1).join(sep).trim();
    return username && password ? { name: username, username, password } : null;
  }).filter(Boolean);
}

function accountProfileTargets(account: any): string[] {
  return [account.login_username, account.username, account.name]
    .map(v => String(v || '').trim().toLowerCase())
    .filter(v => v && v !== 'unknown');
}

function profileBelongsToAccount(account: any, profile: any): boolean {
  const targets = accountProfileTargets(account);
  if (!targets.length) return true;
  const fields = [profile?.name, profile?.userName, profile?.username]
    .map(v => String(v || '').trim().toLowerCase())
    .filter(Boolean);
  return targets.some(t => fields.includes(t));
}

async function resolveBitBrowserProfile(account: any, client: BitBrowserClient): Promise<{ profileId: string; autoBound: boolean; matchedProfile?: any; runningContext?: any }> {
  // 1) If a profile is already bound, use it directly. Do not scan the whole
  // BitBrowser list before every login: the local API rate-limits pagination and
  // can fail with “请求频繁”, preventing the real login flow from even starting.
  if (account.bitbrowser_profile_id) {
    return { profileId: String(account.bitbrowser_profile_id), autoBound: false };
  }

  // 2) Match by exact account email/name from BitBrowser profile list.
  const matched = await client.findProfileForAccount(account);
  if (matched?.id) {
    db.updateAccountBitBrowserProfile(Number(account.id), String(matched.id));
    return { profileId: String(matched.id), autoBound: true, matchedProfile: matched };
  }

  // 3) Only use an already-running Dreamina context for accounts without a
  // login username. For imported username/password accounts this fallback is
  // unsafe because it can bind the current account to another user's open tab.
  if (!account.login_username) {
    const running = await discoverRunningDreaminaContext([account.cdp_port]);
    if (running?.profileId) {
      db.updateAccountBitBrowserProfile(Number(account.id), running.profileId);
      db.updateAccountBitBrowserRuntime(Number(account.id), {
        cdp_port: running.cdpPort,
        cdp_ws_url: running.pageWsUrl || '',
        bitbrowser_window_id: running.profileId,
      });
      return { profileId: running.profileId, autoBound: true, runningContext: running };
    }
  }

  // 4) Create a dedicated BitBrowser profile for this account.
  if (account.login_username || account.name) {
    const created = await client.createProfileForAccount(account);
    if (created?.id) {
      db.updateAccountBitBrowserProfile(Number(account.id), String(created.id));
      return { profileId: String(created.id), autoBound: true, matchedProfile: created };
    }
  }

  throw new Error(`账号未绑定 BitBrowser profile，且未能自动匹配或自动创建。请检查 BitBrowser API 是否支持创建窗口，或手动绑定 Profile ID。账号：${account.login_username || account.name}`);
}

export default {
  prefix: '/dashboard',

  get: {
    // 检查是否需要初始化设置
    '/status': async (request: Request) => {
      return {
        setupComplete: db.isSetupComplete()
      };
    },

    // 获取统计数据
    '/stats': async (request: Request) => {
      requireAuth(request);
      return db.getStats();
    },

    // 获取日志
    '/logs': async (request: Request) => {
      requireAuth(request);
      const level = request.query.level as string;
      const limit = parseInt(request.query.limit as string) || 100;
      return db.getLogs(level, limit);
    },

    // 获取媒体列表（分页）
    '/media': async (request: Request) => {
      requireAuth(request);
      const page = parseInt(request.query.page as string) || 1;
      const limit = parseInt(request.query.limit as string) || 20;
      const type = request.query.type as string;
      return db.getMedia(page, limit, type);
    },

    // 获取指定Key的积分
    '/credits': async (request: Request) => {
      requireAuth(request);
      const key = request.query.key as string;
      if (!key) {
        return { error: '缺少Key参数' };
      }
      try {
        const credits = await getCredit(key);
        return credits;
      } catch (e) {
        return { error: '查询失败', message: e.message };
      }
    },

    // 获取即梦账号列表
    '/accounts': async (request: Request) => {
      requireAuth(request);
      return db.getAccounts();
    },

    // 获取远程 BitBrowser/CDP 设置
    '/browser-settings': async (request: Request) => {
      requireAuth(request);
      return db.getRemoteBrowserSettings();
    },

    // 获取API Key列表
    '/api-keys': async (request: Request) => {
      requireAuth(request);
      return db.getApiKeys();
    },

    // 获取积分消耗规则列表
    '/cost-rules': async (request: Request) => {
      requireAuth(request);
      return db.getCostRules();
    }
  },

  post: {
    // 初始化设置账号密码
    '/setup': async (request: Request) => {
      if (db.isSetupComplete()) {
        return new Response({ error: '已完成初始化设置' }, { statusCode: 400 });
      }
      const { username, password } = request.body;
      if (!username || !password) {
        return new Response({ error: '用户名和密码不能为空' }, { statusCode: 400 });
      }
      if (password.length < 6) {
        return new Response({ error: '密码长度至少6位' }, { statusCode: 400 });
      }
      db.createUser(username, password);
      return { success: true, message: '设置成功' };
    },

    // 登录
    '/login': async (request: Request) => {
      const { username, password } = request.body;
      const userId = db.validateUser(username, password);
      if (!userId) {
        return new Response({ error: '用户名或密码错误' }, { statusCode: 401 });
      }
      const sessionId = db.createSession(userId);
      return new Response(
        { success: true },
        {
          statusCode: 200,
          headers: { 'Set-Cookie': `session=${sessionId}; Path=/; HttpOnly; Max-Age=86400` }
        }
      );
    },

    // 登出
    '/logout': async (request: Request) => {
      const sessionId = request.headers.cookie?.match(/session=([^;]+)/)?.[1];
      if (sessionId) {
        db.deleteSession(sessionId);
      }
      return new Response(
        { success: true },
        {
          statusCode: 200,
          headers: { 'Set-Cookie': 'session=; Path=/; HttpOnly; Max-Age=0' }
        }
      );
    },

    // 修改密码
    '/password': async (request: Request) => {
      const userId = requireAuth(request);
      const { newPassword } = request.body;
      if (!newPassword || newPassword.length < 6) {
        return new Response({ error: '密码长度至少6位' }, { statusCode: 400 });
      }
      db.changePassword(userId, newPassword);
      return { success: true, message: '密码修改成功' };
    },

    // 根据 BitBrowser API 自动检测 Dreamina CDP 地址
    '/browser-settings/detect-cdp': async (request: Request) => {
      requireAuth(request);
      const bitbrowser_api_base = String(request.body.bitbrowser_api_base || db.getSetting('bitbrowser_api_base', '') || '').trim();
      if (!bitbrowser_api_base) {
        return new Response({ error: '请先填写 BitBrowser API 地址' }, { statusCode: 400 });
      }
      if (!/^https?:\/\//i.test(bitbrowser_api_base)) {
        return new Response({ error: 'BitBrowser API 地址必须以 http:// 或 https:// 开头' }, { statusCode: 400 });
      }
      try {
        const client = new BitBrowserClient(bitbrowser_api_base);
        const detected = await client.detectDreaminaCdpBase();
        return { success: true, dreamina_cdp_base: detected.cdpBase, profile_id: detected.profileId, cdp_port: detected.cdpPort, has_dreamina_page: detected.hasDreaminaPage, warning: detected.warning || '' };
      } catch (e) {
        return new Response({ error: '自动检测失败: ' + e.message }, { statusCode: 500 });
      }
    },

    // 保存远程 BitBrowser/CDP 设置（页面只暴露必须项）
    '/browser-settings': async (request: Request) => {
      requireAuth(request);
      const bitbrowser_api_base = String(request.body.bitbrowser_api_base || '').trim();
      const dreamina_cdp_base = String(request.body.dreamina_cdp_base || '').trim();
      if (!bitbrowser_api_base) {
        return new Response({ error: 'BitBrowser API 地址不能为空' }, { statusCode: 400 });
      }
      if (!/^https?:\/\//i.test(bitbrowser_api_base)) {
        return new Response({ error: 'BitBrowser API 地址必须以 http:// 或 https:// 开头' }, { statusCode: 400 });
      }
      if (dreamina_cdp_base && !/^https?:\/\//i.test(dreamina_cdp_base)) {
        return new Response({ error: 'Dreamina CDP 地址必须以 http:// 或 https:// 开头' }, { statusCode: 400 });
      }
      db.updateRemoteBrowserSettings({ bitbrowser_api_base, dreamina_cdp_base });
      return { success: true, message: '远程浏览器设置已保存' };
    },

    // 添加即梦账号
    '/accounts': async (request: Request) => {
      requireAuth(request);
      const { name, token, region, proxy_url, cookie } = request.body;
      if (!name || !token) {
        return new Response({ error: '名称和Token不能为空' }, { statusCode: 400 });
      }
      try {
        const id = db.addAccount(name, token, region || 'cn', proxy_url || '', cookie || '');
        return { success: true, id, message: '账号添加成功' };
      } catch (e) {
        return new Response({ error: '添加失败: ' + e.message }, { statusCode: 500 });
      }
    },

    // 更新账号代理
    '/accounts/proxy': async (request: Request) => {
      requireAuth(request);
      const { id, proxy_url } = request.body;
      if (!id) {
        return new Response({ error: '缺少账号ID' }, { statusCode: 400 });
      }
      try {
        db.updateAccountProxy(id, proxy_url || '');
        return { success: true, message: '代理设置已更新' };
      } catch (e) {
        return new Response({ error: '更新失败: ' + e.message }, { statusCode: 500 });
      }
    },

    // 更新账号 Cookie
    '/accounts/cookie': async (request: Request) => {
      requireAuth(request);
      const { id, cookie } = request.body;
      if (!id) {
        return new Response({ error: '缺少账号ID' }, { statusCode: 400 });
      }
      try {
        db.updateAccountCookie(id, cookie || '');
        return { success: true, message: 'Cookie 已更新' };
      } catch (e) {
        return new Response({ error: '更新失败: ' + e.message }, { statusCode: 500 });
      }
    },

    // 批量导入账号密码（测试/正式接入 BitBrowser 登录用）
    '/accounts/import-login': async (request: Request) => {
      requireAuth(request);
      const { accounts, raw, region, proxy_url } = request.body;
      const rows = Array.isArray(accounts) ? accounts : parseLoginAccountLines(raw || '');
      if (!rows.length) {
        return new Response({ error: 'accounts 不能为空' }, { statusCode: 400 });
      }
      const ids: number[] = [];
      for (const row of rows) {
        const username = String(row.username || row.email || '').trim();
        const password = String(row.password || '').trim();
        if (!username || !password) continue;
        ids.push(db.importLoginAccount({
          name: row.name || username,
          username,
          password,
          region: row.region || region || 'vn',
          proxy_url: row.proxy_url || proxy_url || '',
          bitbrowser_profile_id: row.bitbrowser_profile_id || row.profile_id || ''
        }));
      }
      return { success: true, ids, message: `已导入 ${ids.length} 个账号` };
    },

    // 绑定已有 BitBrowser profile 到账号
    '/accounts/bitbrowser/bind': async (request: Request) => {
      requireAuth(request);
      const { id, profile_id } = request.body;
      if (!id || !profile_id) return new Response({ error: '缺少 id 或 profile_id' }, { statusCode: 400 });
      db.updateAccountBitBrowserProfile(Number(id), String(profile_id));
      return { success: true, message: 'BitBrowser profile 已绑定' };
    },

    // 透传创建/更新 BitBrowser profile：不同 BitBrowser 版本字段有差异，调用方传完整 payload。
    '/accounts/bitbrowser/create': async (request: Request) => {
      requireAuth(request);
      const { id, payload } = request.body;
      if (!id || !payload) return new Response({ error: '缺少 id 或 payload' }, { statusCode: 400 });
      const account = db.getAccountById(Number(id));
      if (!account) return new Response({ error: '账号不存在' }, { statusCode: 404 });
      try {
        const client = new BitBrowserClient();
        const data = await client.createOrUpdate(payload);
        const profileId = data?.id || data?.browserId || data?.browser_id || payload.id;
        if (profileId) db.updateAccountBitBrowserProfile(Number(id), String(profileId));
        return { success: true, profile_id: profileId, data };
      } catch (e) {
        return new Response({ error: '创建 BitBrowser profile 失败: ' + e.message }, { statusCode: 500 });
      }
    },

    // 打开账号绑定的 BitBrowser profile，并记录 CDP 端口
    '/accounts/bitbrowser/open': async (request: Request) => {
      requireAuth(request);
      const { id } = request.body;
      const account = db.getAccountById(Number(id));
      if (!account) return new Response({ error: '账号不存在' }, { statusCode: 404 });
      try {
        const client = new BitBrowserClient();
        const resolved = await resolveBitBrowserProfile(account, client);
        let repaired = false;
        const opened = await client.openForAccount(resolved.profileId, account, message => {
          repaired = true;
          updateLoginProgress(Number(id), message, { stage: 'opening_browser', percent: 15, status: 'logging_in' });
        });
        db.updateAccountBitBrowserRuntime(Number(id), {
          cdp_port: opened.cdpPort || 0,
          cdp_ws_url: '',
          bitbrowser_window_id: resolved.profileId
        });
        if (repaired) {
          db.updateAccountLoginStatus(Number(id), 'need_2fa', 'BitBrowser 代理配置已修复，窗口已打开；请完成 Dreamina 登录后点击“检测”');
        }
        return { success: true, autoBound: resolved.autoBound, matchedProfile: resolved.matchedProfile ? { id: resolved.matchedProfile.id, name: resolved.matchedProfile.name, seq: resolved.matchedProfile.seq } : undefined, runningContext: resolved.runningContext, data: opened };
      } catch (e) {
        const message = formatBitBrowserOperationError(
          '打开 BitBrowser',
          e,
          '请确认 BitBrowser API 服务及该 Profile 可用',
        );
        db.updateAccountLoginStatus(Number(id), 'failed', message);
        return new Response({ error: message }, { statusCode: 500 });
      }
    },

    // 自动/半自动登录 Dreamina。耗时较长，作为后台任务启动；遇到验证码后人工完成再调用 check-login。
    '/accounts/bitbrowser/login': async (request: Request) => {
      requireAuth(request);
      const { id } = request.body;
      const account = db.getAccountById(Number(id));
      if (!account) return new Response({ error: '账号不存在' }, { statusCode: 404 });
      const accountId = Number(id);
      if (loginTasks.has(accountId)) {
        return new Response({ error: '该账号登录流程正在执行，请等待完成后再试' }, { statusCode: 409 });
      }

      loginTasks.add(accountId);
      db.updateAccountLoginStatus(accountId, 'logging_in', '登录任务已启动');

      // 不阻塞 HTTP 请求：浏览器登录可能等待页面加载/验证码/跳转，前端通过账号列表状态观察结果。
      (async () => {
        try {
          const client = new BitBrowserClient();
          // Profile resolution can involve a paginated BitBrowser API call or
          // profile creation. Persist this phase before awaiting it so the UI
          // never appears stuck at the generic "登录中" state.
          updateLoginProgress(accountId, '正在匹配 BitBrowser Profile', {
            stage: 'resolving_profile',
            percent: 8,
            status: 'logging_in',
          });
          const resolved = await resolveBitBrowserProfile(account, client);
          updateLoginProgress(accountId, 'Profile 已匹配，正在打开浏览器', {
            stage: 'opening_browser',
            percent: 15,
            status: 'logging_in',
          });
          const result = await loginDreaminaViaBitBrowser({
            bitbrowserProfileId: resolved.profileId,
            proxyUrl: account.proxy_url,
            username: account.login_username,
            password: db.decryptSecret(account.login_password || ''),
            onOpened: (runtime) => {
              // Persist the runtime as soon as BitBrowser opens. The user may
              // need to finish a captcha/2FA manually while the detached task
              // is still running, and check-login must be able to find the
              // correct CDP endpoint during that window.
              db.updateAccountBitBrowserRuntime(accountId, {
                cdp_port: runtime.cdpPort || 0,
                cdp_ws_url: runtime.cdpWsUrl || '',
                bitbrowser_window_id: resolved.profileId,
                user_agent: runtime.userAgent || '',
              });
            },
            onProgress: (message) => {
              updateLoginProgress(accountId, message || '登录处理中');
            },
          });
          db.updateAccountBitBrowserRuntime(accountId, {
            cdp_port: result.cdpPort || 0,
            cdp_ws_url: result.cdpWsUrl || '',
            bitbrowser_window_id: resolved.profileId,
            user_agent: result.userAgent || ''
          });
          if (result.cookies) {
            const sessionToken = extractDreaminaSessionToken(result.cookies);
            if (sessionToken) {
              const token = `${account.region || 'vn'}-${sessionToken}`;
              db.updateAccountTokenAndCookie(accountId, token, result.cookies);
            } else {
              db.updateAccountCookie(accountId, result.cookies);
            }
          }
          db.updateAccountLoginStatus(
            accountId,
            result.status,
            result.message || (result.status === 'failed' ? '登录未确认' : ''),
          );
        } catch (e) {
          db.updateAccountLoginStatus(accountId, 'failed', formatBitBrowserOperationError('Dreamina 登录', e));
        } finally {
          loginTasks.delete(accountId);
        }
      })();

      return { success: true, pending: true, message: '登录任务已启动，请观察账号列表状态；如出现验证码，请在 BitBrowser 中人工完成后点击“检测”。' };
    },

    // 检测当前 BitBrowser 页面登录状态；人工处理验证码后使用
    '/accounts/bitbrowser/check-login': async (request: Request) => {
      requireAuth(request);
      const { id } = request.body;
      const account = db.getAccountById(Number(id));
      if (!account) return new Response({ error: '账号不存在' }, { statusCode: 404 });
      let cdpPort = Number(account.cdp_port || 0);
      let cdpWsUrl = account.cdp_ws_url || undefined;
      const profileId = String(account.bitbrowser_profile_id || account.bitbrowser_window_id || '').trim();
      try {
        if (!cdpPort) {
          if (!profileId) {
            const message = '账号没有已绑定的 BitBrowser 窗口或 CDP 端口，请先绑定 Profile 并打开该账号窗口，再手动登录后检测';
            db.updateAccountLoginStatus(Number(id), 'failed', message);
            return new Response({ error: message }, { statusCode: 400 });
          }
        }
        updateLoginProgress(Number(id), '正在检测当前页面登录状态', {
          stage: 'checking_session', percent: 85, status: 'logging_in'
        });
        let result;
        let firstCheckError: any;
        if (cdpPort) {
          try {
            result = await checkDreaminaLoginByCdp(cdpPort, cdpWsUrl);
          } catch (error) {
            firstCheckError = error;
          }
        }
        // Opening a BitBrowser profile is a launch operation. Reuse its saved
        // CDP endpoint for normal checks; only reopen this account's bound
        // profile when that endpoint is no longer reachable.
        if (!result && profileId) {
          updateLoginProgress(Number(id), '正在重新连接已绑定 BitBrowser 窗口', {
            stage: 'connecting_cdp', percent: 35, status: 'logging_in'
          });
          const opened = await new BitBrowserClient().openForAccount(profileId, account, message => {
            updateLoginProgress(Number(id), message, { stage: 'connecting_cdp', percent: 35, status: 'logging_in' });
          });
          if (!opened.cdpPort) {
            throw new Error(`已绑定 Profile 未返回有效 CDP 端口${firstCheckError ? `；旧端口检测失败：${firstCheckError.message}` : ''}`);
          }
          cdpPort = opened.cdpPort;
          cdpWsUrl = opened.ws?.includes('/devtools/page/') ? opened.ws : undefined;
          db.updateAccountBitBrowserRuntime(Number(id), {
            cdp_port: cdpPort,
            cdp_ws_url: cdpWsUrl || '',
            bitbrowser_window_id: profileId,
            user_agent: account.user_agent || '',
          });
          result = await checkDreaminaLoginByCdp(cdpPort, cdpWsUrl);
        }
        if (!result) {
          throw firstCheckError || new Error('账号 CDP 检测失败');
        }
        db.updateAccountBitBrowserRuntime(Number(id), {
          cdp_port: result.cdpPort || cdpPort,
          cdp_ws_url: result.cdpWsUrl || cdpWsUrl || '',
          bitbrowser_window_id: profileId,
          user_agent: result.userAgent || account.user_agent || '',
        });
        if (result.cookies) {
          const sessionToken = extractDreaminaSessionToken(result.cookies);
          if (sessionToken) {
            const token = `${account.region || 'vn'}-${sessionToken}`;
            db.updateAccountTokenAndCookie(Number(id), token, result.cookies);
          }
        }
        const message = result.message || (result.status === 'failed'
          ? '绑定窗口尚未检测到有效登录态，请在该账号的 Dreamina 页面完成登录，再点击“检测”'
          : '');
        db.updateAccountLoginStatus(
          Number(id),
          result.status,
          message,
        );
        return { success: result.status === 'ok', ...result, message };
      } catch (e) {
        const message = formatBitBrowserOperationError(
          '检测绑定账号窗口',
          e,
          '请确认该账号的 BitBrowser 窗口及 CDP 端口可从 API 服务器访问',
        );
        db.updateAccountLoginStatus(Number(id), 'failed', message);
        return new Response({ error: message }, { statusCode: 500 });
      }
    },

    // 获取积分消耗规则
    '/cost-rules': async (request: Request) => {
      requireAuth(request);
      return db.getCostRules();
    },

    // 添加积分消耗规则
    '/cost-rules/add': async (request: Request) => {
      requireAuth(request);
      const { task_type, model_pattern, region, resolution, duration_min, duration_max, credits_cost, priority, description } = request.body;
      if (!task_type || !credits_cost) {
        return new Response({ error: 'task_type 和 credits_cost 不能为空' }, { statusCode: 400 });
      }
      try {
        const id = db.addCostRule({ task_type, model_pattern, region, resolution, duration_min, duration_max, credits_cost, priority, description });
        return { success: true, id, message: '规则添加成功' };
      } catch (e) {
        return new Response({ error: '添加失败: ' + e.message }, { statusCode: 500 });
      }
    },

    // 更新积分消耗规则
    '/cost-rules/update': async (request: Request) => {
      requireAuth(request);
      const { id, ...fields } = request.body;
      if (!id) {
        return new Response({ error: '缺少规则ID' }, { statusCode: 400 });
      }
      try {
        db.updateCostRule(id, fields);
        return { success: true, message: '规则已更新' };
      } catch (e) {
        return new Response({ error: '更新失败: ' + e.message }, { statusCode: 500 });
      }
    },

    // 删除积分消耗规则
    '/cost-rules/delete': async (request: Request) => {
      requireAuth(request);
      const { id } = request.body;
      if (!id) {
        return new Response({ error: '缺少规则ID' }, { statusCode: 400 });
      }
      try {
        db.deleteCostRule(id);
        return { success: true, message: '规则已删除' };
      } catch (e) {
        return new Response({ error: '删除失败: ' + e.message }, { statusCode: 500 });
      }
    },

    // 检查即梦账号积分
    '/accounts/check': async (request: Request) => {
      requireAuth(request);
      const { id } = request.body;
      if (!id) {
        return new Response({ error: '缺少账号ID' }, { statusCode: 400 });
      }
      const token = db.getAccountToken(id);
      if (!token) {
        return new Response({ error: '账号不存在' }, { statusCode: 404 });
      }
      try {
        const credits = await getCredit(token);
        db.updateAccountCredits(id, credits.totalCredit, credits.totalCredit);
        db.updateAccountStatus(id, 'active');
        return { success: true, credits };
      } catch (e) {
        db.updateAccountStatus(id, 'error');
        return { success: false, error: e.message };
      }
    },

    // 生成API Key
    '/api-keys': async (request: Request) => {
      requireAuth(request);
      const { name, account_id } = request.body;
      if (!name) {
        return new Response({ error: '名称不能为空' }, { statusCode: 400 });
      }
      try {
        const apiKey = db.generateApiKey(name, account_id);
        return { success: true, api_key: apiKey, message: 'API Key生成成功' };
      } catch (e) {
        return new Response({ error: '生成失败: ' + e.message }, { statusCode: 500 });
      }
    },

    // 切换API Key状态
    '/api-keys/toggle': async (request: Request) => {
      requireAuth(request);
      const { id, is_active } = request.body;
      if (!id) {
        return new Response({ error: '缺少Key ID' }, { statusCode: 400 });
      }
      db.toggleApiKey(id, is_active);
      return { success: true, message: is_active ? '已启用' : '已禁用' };
    },

    // 手动触发账号存活检测
    '/accounts/health-check': async (request: Request) => {
      requireAuth(request);
      try {
        const result = await triggerHealthCheck();
        return { success: true, message: '存活检测完成', ...result };
      } catch (e) {
        return new Response({ error: '检测失败: ' + e.message }, { statusCode: 500 });
      }
    },

    // 手动触发积分同步
    '/accounts/sync-credits': async (request: Request) => {
      requireAuth(request);
      try {
        const result = await triggerCreditsSync();
        return { success: true, message: '积分同步完成', ...result };
      } catch (e) {
        return new Response({ error: '同步失败: ' + e.message }, { statusCode: 500 });
      }
    }
  },

  delete: {
    // 清理日志
    '/logs': async (request: Request) => {
      requireAuth(request);
      db.clearLogs();
      return { success: true, message: '日志已清理' };
    },

    // 删除即梦账号
    '/accounts': async (request: Request) => {
      requireAuth(request);
      const id = parseInt(request.query.id as string);
      if (!id) {
        return new Response({ error: '缺少账号ID' }, { statusCode: 400 });
      }
      db.deleteAccount(id);
      return { success: true, message: '账号已删除' };
    },

    // 删除媒体记录（支持单个 id 或逗号分隔的 ids 批量删除）
    '/media': async (request: Request) => {
      requireAuth(request);
      const idsParam = request.query.ids as string;
      if (idsParam) {
        const ids = idsParam.split(',').map(s => parseInt(s.trim())).filter(n => Number.isInteger(n) && n > 0);
        if (!ids.length) {
          return new Response({ error: '缺少有效的媒体ID' }, { statusCode: 400 });
        }
        const deleted = db.deleteMediaMany(ids);
        return { success: true, deleted, message: `已删除 ${deleted} 条媒体记录` };
      }
      const id = parseInt(request.query.id as string);
      if (!id) {
        return new Response({ error: '缺少媒体ID' }, { statusCode: 400 });
      }
      const deleted = db.deleteMedia(id);
      if (!deleted) {
        return new Response({ error: '媒体记录不存在' }, { statusCode: 404 });
      }
      return { success: true, message: '媒体已删除' };
    },

    // 删除API Key
    '/api-keys': async (request: Request) => {
      requireAuth(request);
      const id = parseInt(request.query.id as string);
      if (!id) {
        return new Response({ error: '缺少Key ID' }, { statusCode: 400 });
      }
      db.deleteApiKey(id);
      return { success: true, message: 'API Key已删除' };
    }
  }
};
