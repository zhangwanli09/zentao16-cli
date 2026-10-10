import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CONFIG_DIR, type Config } from './config.js';
import { errorFromMessage, ExitCode, RetryableAuthError, SessionExpiredError, ZentaoError } from './errors.js';

/**
 * 一次禅道请求：模块、方法、按方法签名顺序排列的参数。
 * PATH_INFO 模式只认参数顺序（bug-view-123.json），GET 模式只认参数名（?m=bug&f=view&bugID=123），
 * 所以参数既要有名字也要保持顺序。
 */
export interface Route {
  m: string;
  f: string;
  args?: Array<[name: string, value: string | number]>;
  /** 视图类型，即 PATH_INFO 的扩展名，默认 html */
  t?: string;
}

export type RequestType = 'PATH_INFO' | 'GET';

/** 下载文件的最小接口，便于测试时替换 */
export interface Downloader {
  download(route: Route, dest: string): Promise<void>;
}

interface Session {
  sessionName: string;
  sessionID: string;
  requestType: RequestType;
}

const LOGIN_PAGE = /m=user&f=login|user-login/i;

function stripBom(text: string): string {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trim();
}

const messageText = (m: unknown): string => (typeof m === 'string' ? m : JSON.stringify(m));

/**
 * 截取开头第一个完整的 JSON 对象。禅道有些页面会在 JSON 后面追加 <script>，
 * 未登录时还会先输出一个 {"locate":...} 再输出正文。
 */
function leadingJson(text: string): string {
  if (!text.startsWith('{')) return text;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(0, i + 1);
  }
  return text;
}

function tryParseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(leadingJson(stripBom(text))) as T;
  } catch {
    return undefined;
  }
}

/** 非 JSON 的禅道页面：跳登录页视为会话失效，跳无权限页视为权限不足，js::error/js::alert 视为错误提示 */
function throwIfErrorPage(text: string, prefix = ''): void {
  if (LOGIN_PAGE.test(text)) throw new SessionExpiredError();
  // 无权限时禅道返回 HTTP 200 和 <script>self.location='/zentao/user-deny-action-comment.html'</script>
  const deny = /location(?:\.href)?\s*=\s*(['"])([^'"]*user-deny-[^'"]*)\1/.exec(text)?.[2];
  if (deny) classifyRedirect(deny);
  const alert = /alert\((['"])([\s\S]*?)\1\)/.exec(text)?.[2];
  if (alert) throw errorFromMessage(alert, prefix);
}

/** 禅道要求跳转（HTTP Location 或 JSON 里的 locate）时，按目标地址判断原因 */
function classifyRedirect(url: string): never {
  if (!url || LOGIN_PAGE.test(url)) throw new SessionExpiredError();
  const deny = /user-deny-(\w+)-(\w+)/.exec(url);
  if (deny) throw new ZentaoError(`当前禅道账号没有 ${deny[1]}-${deny[2]} 的访问权限，请联系管理员`, ExitCode.Auth);
  // 未登录访问 Bug 等页面时，禅道会因为"没有可访问的产品"跳到 showErrorNone；登录后仍如此才是真的没权限
  if (/showErrorNone/i.test(url)) {
    throw new RetryableAuthError(url, new ZentaoError('禅道提示没有可访问的产品或项目，请检查账号权限', ExitCode.Auth));
  }
  throw new ZentaoError(`禅道要求跳转到 ${url}（可能无权限访问）`);
}

/**
 * 解析旧版 JSON 接口的返回：
 * {"status":"success","data":"<JSON 字符串>","md5":"..."}
 */
export function parseLegacyResponse(raw: string): unknown {
  const json = tryParseJson<{ status?: string; data?: unknown; reason?: string }>(raw);
  if (!json) {
    throwIfErrorPage(raw);
    throw new ZentaoError(`禅道返回了非 JSON 内容：${stripBom(raw).slice(0, 200)}`);
  }
  if (json.status !== 'success') {
    // 未登录时也会这样返回，所以先当作可能的会话失效重试一次
    const msg = `禅道返回失败：${json.reason ?? stripBom(raw).slice(0, 200)}`;
    throw new RetryableAuthError(msg, new ZentaoError(msg));
  }

  type Data = { locate?: string; result?: string; message?: unknown };
  let data = json.data as Data;
  if (typeof json.data === 'string') {
    const parsed = tryParseJson<Data>(json.data);
    if (!parsed) {
      throwIfErrorPage(json.data);
      throw new ZentaoError(`禅道返回的 data 不是合法 JSON：${json.data.slice(0, 200)}`);
    }
    data = parsed;
  }
  // 未登录或无权限时禅道返回跳转地址而不是正文
  if (typeof data?.locate === 'string') classifyRedirect(data.locate);
  if (data?.result === 'fail') throw errorFromMessage(messageText(data.message));
  return data;
}

/** 检查表单提交的返回，禅道失败时返回 {"result":"fail"} 或 alert 脚本 */
export function assertPostOk(raw: string): void {
  const json = stripBom(raw).startsWith('{')
    ? tryParseJson<{ result?: string; status?: string; message?: unknown; reason?: unknown }>(raw)
    : undefined;
  if (!json) return throwIfErrorPage(raw, '禅道拒绝了请求：');
  if (json.result === 'fail' || json.status === 'failed') {
    throw errorFromMessage(messageText(json.message ?? json.reason), '禅道拒绝了请求：');
  }
}

/** 以页面文件结尾的路径，如 /zentao/my.html */
const PAGE_FILE = /\/[^/]*\.(?:php|html?|json)$/i;

/**
 * 校验后的禅道地址。href 是用户填的原样（只补结尾的 /），PATH_INFO 地址相对它拼，
 * 填到 index.php 时自然走 index.php/bug-view-1.json；dir 是 index.php 所在目录，GET 地址相对它拼。
 */
export interface BaseUrl {
  href: string;
  dir: string;
}

/**
 * 校验 ZENTAO_URL 必须是 index.php 所在目录，原样使用，不替用户改写。
 * 填成页面地址（如 http://x/zentao/index.php?m=my、http://x/zentao/my.html）时报错，并给出应填的目录。
 */
export function validateBaseUrl(url: string): BaseUrl {
  const raw = url.trim();
  const u = URL.canParse(raw) ? new URL(raw) : undefined;
  // 'localhost:8080' 这类缺协议的写法会被当成 localhost: 协议解析成功，这里一并拦下
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
    // 'admin:pwd@host' 这类缺协议的写法里可能带密码，报错时遮掉
    throw new ZentaoError(`ZENTAO_URL 不是合法地址：${raw.replace(/^.*@/, '***@')}（需要带 http:// 或 https://）`, ExitCode.Auth);
  }
  // fetch 不接受带账号密码的 URL，且 base 会出现在报错信息里
  if (u.username || u.password) {
    throw new ZentaoError('ZENTAO_URL 中不要包含账号密码，请改用 ZENTAO_ACCOUNT / ZENTAO_PASSWORD', ExitCode.Auth);
  }
  // 以 index.php 结尾的写法也原样接受：没开 URL 重写的服务器只能用 index.php/bug-view-1.json 这种地址
  const path = /^(.*\/)index\.php\/*$/i.exec(u.pathname)?.[1] ?? u.pathname;
  if (/[?#]/.test(raw) || /\/index\.php\//i.test(path) || PAGE_FILE.test(path)) {
    // 页面地址形如 .../index.php/bug-view-1.html 时，说明服务器走 index.php/，建议保留到 index.php
    const viaIndex = /^(.*\/index\.php)\//i.exec(u.pathname)?.[1];
    const suggest = viaIndex ?? withSlash(path.replace(PAGE_FILE, '/'));
    throw new ZentaoError(`ZENTAO_URL 应填 index.php 所在的目录，你填的像是页面地址，请改为 ${u.origin}${suggest}`, ExitCode.Auth);
  }
  return { href: withSlash(raw), dir: u.origin + withSlash(path) };
}

const withSlash = (s: string): string => s.replace(/\/*$/, '/');

/** 按禅道的 URL 模式拼地址 */
export function buildUrl(base: BaseUrl, requestType: RequestType, route: Route): string {
  const t = route.t ?? 'html';
  if (requestType === 'GET') {
    const url = new URL('index.php', base.dir);
    url.searchParams.set('m', route.m);
    url.searchParams.set('f', route.f);
    url.searchParams.set('t', t);
    for (const [k, v] of route.args ?? []) url.searchParams.set(k, String(v));
    return url.toString();
  }
  const segments = [route.m, route.f, ...(route.args ?? []).map(([, v]) => encodeURIComponent(String(v)))];
  return new URL(`${segments.join('-')}.${t}`, base.href).toString();
}

/** 基于网页会话（zentaosid）的禅道客户端，会话缓存在 ~/.zentao 下，失效自动重登 */
export class ZentaoClient implements Downloader {
  private readonly base: BaseUrl;
  private readonly cacheFile: string;
  private session?: Session;
  private requestType: RequestType = 'PATH_INFO';
  private loggedInThisRun = false;
  /** 当前 session 是否已登录（来自缓存或本次登录成功），用于决定 session 变化时是否写回缓存 */
  private authenticated = false;

  constructor(private readonly config: Config) {
    this.base = validateBaseUrl(config.url);
    const key = createHash('sha1').update(`${this.base.href}|${config.account}`).digest('hex').slice(0, 12);
    this.cacheFile = join(CONFIG_DIR, `session-${key}.json`);
  }

  /** 浏览器可直接打开的页面地址 */
  webUrl(route: Route): string {
    return buildUrl(this.base, this.requestType, { ...route, t: 'html' });
  }

  async login(): Promise<Record<string, unknown>> {
    this.session = undefined;
    this.authenticated = false;
    this.session = await this.fetchSessionId();

    const res = await this.send(
      { m: 'user', f: 'login', t: 'json' },
      { account: this.config.account, password: this.config.password, keepLogin: 'on' },
    );
    const text = await res.text();
    const json = tryParseJson<{ status?: string; reason?: string; user?: Record<string, unknown> }>(text);
    if (!json) throw new ZentaoError(`登录返回了非 JSON 内容：${stripBom(text).slice(0, 200)}`, ExitCode.Auth);
    if (json.status !== 'success') throw new ZentaoError(`登录失败：${json.reason ?? '未知原因'}`, ExitCode.Auth);
    // 表单没被处理时禅道也返回 status=success，只是 data 里是登录页，所以要以 user 为准
    if (!json.user) throw new ZentaoError('登录请求未被禅道处理（返回的是登录页面）', ExitCode.Auth);

    this.loggedInThisRun = true;
    this.authenticated = true;
    this.saveSession();
    return json.user;
  }

  /**
   * GET 一个旧版 JSON 视图，返回解析后的 data。
   * unsafe：任意路由（raw 命令）。禅道有些 GET 会改数据，只读模式下拒绝。
   */
  async view<T>(route: Route, opts: { unsafe?: boolean } = {}): Promise<T> {
    if (opts.unsafe) this.assertWritable();
    return this.withSession(async () => parseLegacyResponse(await (await this.send({ ...route, t: 'json' })).text()) as T);
  }

  /** 提交表单并检查禅道是否接受；调用方仍应回读确认结果 */
  async post(route: Route, form: Record<string, string>): Promise<string> {
    this.assertWritable();
    return this.withSession(async () => {
      const text = await (await this.send(route, form)).text();
      assertPostOk(text);
      return text;
    });
  }

  async download(route: Route, dest: string): Promise<void> {
    await this.withSession(async () => {
      const res = await this.send(route);
      const buf = Buffer.from(await res.arrayBuffer());
      // 禅道的跳转/报错页只是一小段 <script>；真正的 HTML 附件不会这么短，不能误判
      if ((res.headers.get('content-type') ?? '').includes('text/html') && buf.length < 1024) {
        const text = buf.toString('utf8');
        if (/<script/i.test(text)) throwIfErrorPage(text, '下载失败：');
      }
      mkdirSync(dirname(dest), { recursive: true });
      await writeFile(dest, buf);
    });
  }

  private assertWritable(): void {
    if (this.config.readonly) {
      throw new ZentaoError(`当前为只读模式（ZENTAO_READONLY=1 或存在 ${join(CONFIG_DIR, 'readonly')}），已拒绝写操作`);
    }
  }

  /** 取 sessionID，同时确定 URL 模式：先试已知（或默认 PATH_INFO）的模式，拿不到 JSON 再试另一种 */
  private async fetchSessionId(): Promise<Session> {
    let lastError: unknown;
    const order: RequestType[] = this.requestType === 'GET' ? ['GET', 'PATH_INFO'] : ['PATH_INFO', 'GET'];
    for (const requestType of order) {
      this.requestType = requestType;
      try {
        const sid = parseLegacyResponse(await (await this.send({ m: 'api', f: 'getSessionID', t: 'json' })).text()) as Partial<Session>;
        if (sid?.sessionName && sid.sessionID) return { sessionName: sid.sessionName, sessionID: sid.sessionID, requestType };
      } catch (e) {
        lastError = e;
      }
    }
    const reason = lastError instanceof Error ? `（${lastError.message}）` : '';
    throw new ZentaoError(`获取 sessionID 失败，请检查 ZENTAO_URL 是否为禅道 index.php 所在的目录${reason}`, ExitCode.Auth);
  }

  /** 确保有会话；遇到可能的会话失效时（本次运行还没登录过的话）重新登录并重试一次 */
  private async withSession<T>(run: () => Promise<T>): Promise<T> {
    if (!this.session) {
      const cached = this.loadSession();
      if (cached) {
        this.session = cached;
        this.requestType = cached.requestType;
        this.authenticated = true;
      } else {
        await this.login();
      }
    }
    try {
      return await run();
    } catch (e) {
      if (!(e instanceof RetryableAuthError)) throw e;
      if (this.loggedInThisRun) throw e.final;
      await this.login();
      try {
        return await run();
      } catch (retryError) {
        throw retryError instanceof RetryableAuthError ? retryError.final : retryError;
      }
    }
  }

  private async send(route: Route, form?: Record<string, string>): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.session) headers.Cookie = `${this.session.sessionName}=${this.session.sessionID}`;
    const init: RequestInit = { headers, redirect: 'manual' };
    if (form) {
      init.method = 'POST';
      init.body = new URLSearchParams(form);
      // 禅道会丢弃没有来源页的 POST（防 CSRF），表单会被当成空提交
      headers.Referer = this.base.href;
      headers.Origin = new URL(this.base.href).origin;
      // 让禅道以 ajax 方式返回结果，便于判断成功与否
      if (route.m !== 'user') headers['X-Requested-With'] = 'XMLHttpRequest';
    }

    let res: Response;
    try {
      res = await fetch(buildUrl(this.base, this.requestType, route), init);
    } catch (e) {
      const cause = (e as { cause?: Error }).cause?.message ?? (e as Error).message;
      throw new ZentaoError(`无法连接禅道 ${this.base.href}：${cause}`);
    }
    this.captureCookie(res);

    if (res.status >= 300 && res.status < 400) classifyRedirect(res.headers.get('location') ?? '');
    if (res.status === 401) throw new SessionExpiredError();
    // 403 是真正的权限拒绝，重新登录也没用
    if (res.status === 403) throw new ZentaoError('禅道返回 HTTP 403，当前账号无权访问该资源', ExitCode.Auth);
    if (!res.ok) throw new ZentaoError(`禅道返回 HTTP ${res.status}`);
    return res;
  }

  /** 登录后禅道可能会重新生成 session id，跟随 Set-Cookie 更新 */
  private captureCookie(res: Response): void {
    if (!this.session) return;
    const prefix = `${this.session.sessionName}=`;
    for (const cookie of res.headers.getSetCookie()) {
      if (!cookie.startsWith(prefix)) continue;
      const value = cookie.slice(prefix.length).split(';')[0];
      if (!value || value === 'deleted' || value === this.session.sessionID) continue;
      this.session.sessionID = value;
      // 已登录状态下禅道换了 session，要写回缓存，否则下次运行会带着失效的 id 多登录一次
      if (this.authenticated) this.saveSession();
    }
  }

  private loadSession(): Session | undefined {
    try {
      const s = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as Session;
      return s.requestType ? s : undefined;
    } catch {
      return undefined;
    }
  }

  private saveSession(): void {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(this.cacheFile, JSON.stringify(this.session), { mode: 0o600 });
  }
}
