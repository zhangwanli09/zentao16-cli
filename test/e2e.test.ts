/**
 * 用本地模拟的禅道服务端跑通完整链路。模拟行为按真实 16.5 环境观察到的情况编写：
 * - PATH_INFO 模式：/zentao/bug-view-101.json，index.php?m=... 会落到首页并跳登录
 * - 没有 Referer 的 POST 会被当成空表单，登录接口返回登录页（status 仍是 success）
 * - 未登录访问 Bug 会 302 到 product-showErrorNone；其他页面先输出 {"locate":登录页} 再输出正文
 * - 部分页面在 JSON 后追加 <script>
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'zentao-e2e-'));
process.env.ZENTAO_HOME = home;

const { ZentaoClient } = await import('../src/client.js');
const { fetchTicket, listMine } = await import('../src/ticket.js');
const { addComment, assignBug, resolveBug } = await import('../src/actions.js');
const { ExitCode, ZentaoError } = await import('../src/errors.js');

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/bug-view.json', import.meta.url), 'utf8'));
const TRAILING_SCRIPT = '<script>\nvar bugCount = 3;\n</script>';

/** 模拟禅道：已登录的 session 集合 + 一张可变的 Bug */
class FakeZentao {
  loggedIn = new Set<string>();
  logins = 0;
  /** 最近一次 my-work 收到的位置参数（PATH_INFO 只看顺序） */
  myWorkArgs: string[] = [];
  /** 模拟 my-work 签名里带 param 的禅道：recPerPage 往后挪一位 */
  myWorkHasParam = false;
  /** 退回旧接口 my-bug 的次数 */
  myBugCalls = 0;
  view = structuredClone(fixture);
  private seq = 0;

  private addAction(action: string, comment: string | null, extra = '') {
    const id = String(1000 + Object.keys(this.view.actions).length);
    this.view.actions[id] = { id, actor: 'dev1', action, date: '2026-10-09 12:00:00', comment, extra, history: [] };
  }

  handle =async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, 'http://x');
    // 只认 PATH_INFO：/zentao/<m>-<f>-<args...>.<t>
    const m = /^\/zentao\/([a-zA-Z]+)-([a-zA-Z]+)((?:-[^./]*)*)\.(\w+)$/.exec(url.pathname);
    const sid = /zentaosid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const raw = await new Promise<string>((r) => {
      let s = '';
      req.on('data', (c) => (s += c));
      req.on('end', () => r(s));
    });
    // 没有来源页的 POST 被丢弃
    const body = new URLSearchParams(req.method === 'POST' && req.headers.referer ? raw : '');
    const json = (o: unknown) => res.end(JSON.stringify(o));
    const legacy = (data: unknown) => JSON.stringify({ status: 'success', data: JSON.stringify(data), md5: 'x' });

    if (!m) {
      res.setHeader('Content-Type', 'text/html');
      return res.end("<script>self.location='/zentao/user-login-L3plbnRhby8=.html';</script>");
    }
    const [, mod, method, argStr, t] = m;
    const args = argStr.split('-').slice(1);
    const route = `${mod}-${method}`;

    if (route === 'api-getSessionID') {
      const id = `s${++this.seq}`;
      res.setHeader('Set-Cookie', `zentaosid=${id}; path=/zentao/`);
      return res.end(legacy({ title: '', sessionName: 'zentaosid', sessionID: id, rand: 1 }));
    }
    if (route === 'user-login') {
      if (!body.has('account')) return res.end(legacy({ title: '用户登录', referer: '/zentao/', rand: 123 }));
      if (body.get('account') !== 'dev1' || body.get('password') !== 'secret') {
        return json({ status: 'failed', reason: '登录失败，请检查您的用户名或密码是否填写正确。' });
      }
      // 模拟 session_regenerate_id：登录后换一个新的 session id
      const fresh = `s${++this.seq}`;
      this.loggedIn.add(fresh);
      this.logins++;
      res.setHeader('Set-Cookie', `zentaosid=${fresh}; path=/zentao/`);
      return json({ status: 'success', user: { account: 'dev1', realname: '开发乙' } });
    }

    if (!sid || !this.loggedIn.has(sid)) {
      if (route === 'bug-view') {
        res.statusCode = 302;
        res.setHeader('Location', '/zentao/product-showErrorNone-qa-bug-0.json');
        return res.end(legacy({ locate: 'http://x/zentao/user-login-abc.json' }));
      }
      if (t === 'json') return res.end(legacy({ locate: 'http://x/zentao/user-login-abc.json' }) + legacy({ result: 'fail' }));
      res.setHeader('Content-Type', 'text/html');
      return res.end("<script>top.location='/zentao/user-login.html'</script>");
    }

    if (route === 'bug-view') {
      if (args[0] !== '101') return res.end(legacy({ result: 'fail', message: '抱歉，您访问的对象不存在！' }));
      return res.end(legacy(this.view) + TRAILING_SCRIPT);
    }
    if (route === 'my-work' || route === 'my-bug') {
      // 和真实环境一样，pager 回显实际生效的每页条数，没传或传 0 时为默认的 20
      let recPerPage = 20;
      if (route === 'my-work') {
        this.myWorkArgs = args;
        recPerPage = Number(args[this.myWorkHasParam ? 5 : 4]) || 20;
      } else this.myBugCalls++;
      const bugs = [{ id: '101', title: this.view.bug.title, status: this.view.bug.status, pri: '3', severity: '2', openedBy: 'tester1', openedDate: '2026-09-30 10:12:00' }];
      const pager = { recTotal: bugs.length, recPerPage, pageID: 1 };
      return res.end(legacy({ title: '地盘-我的Bug', bugs, users: this.view.users, pager }) + TRAILING_SCRIPT);
    }
    if (mod === 'file') {
      res.setHeader('Content-Type', 'image/png');
      return res.end(PNG);
    }
    if (route === 'action-comment' && req.method === 'POST') {
      if (!body.has('actioncomment')) return res.end("<script>parent.location.reload()</script>");
      this.addAction('commented', body.get('actioncomment'));
      return res.end("<script>parent.location.reload()</script>");
    }
    if (route === 'bug-assignTo' && req.method === 'POST') {
      const to = body.get('assignedTo')!;
      this.addAction('assigned', body.get('comment'), to);
      this.view.bug.assignedTo = to;
      return res.end("<script>parent.parent.location.reload()</script>");
    }
    if (route === 'bug-resolve' && req.method === 'POST') {
      if (!body.get('resolvedBuild')) return json({ result: 'fail', message: { resolvedBuild: ['『解决版本』不能为空。'] } });
      Object.assign(this.view.bug, { status: 'resolved', resolution: body.get('resolution'), assignedTo: body.get('assignedTo') });
      return json({ result: 'success', message: '保存成功' });
    }
    res.statusCode = 404;
    res.end('not found');
  };
}

let server: Server;
let fake: FakeZentao;
let url: string;
const config = () => ({ url, account: 'dev1', password: 'secret' });

beforeAll(async () => {
  fake = new FakeZentao();
  server = createServer(fake.handle);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/zentao/`;
});

afterAll(() => {
  server.close();
  rmSync(home, { recursive: true, force: true });
});

describe('与模拟禅道（PATH_INFO）的完整链路', () => {
  it('首次使用自动登录，跟随新 session，读单据并下载图片', async () => {
    const out = join(home, 'out');
    const t = await fetchTicket(new ZentaoClient(config()), 'bug', 101, { download: true, outDir: out, repos: {} });
    expect(fake.logins).toBe(1);
    expect(t.title).toBe('登录页验证码不刷新');
    expect(t.warnings).toEqual([]);
    expect(existsSync(join(out, 'bug-101', '55-截图_1.png'))).toBe(true);
    expect(existsSync(join(out, 'bug-101', '57-file.png'))).toBe(true);
    expect(t.url).toMatch(/\/zentao\/bug-view-101\.html$/);
  });

  it('复用缓存的会话，不重复登录；忽略 JSON 后追加的脚本', async () => {
    const { rows, truncated } = await listMine(new ZentaoClient(config()), 'bug');
    expect(rows.map((r) => r.id)).toEqual([101]);
    expect(truncated).toBe(false);
    expect(fake.logins).toBe(1);
  });

  it('my-work 按 16.5 的签名传参：mode、type、orderBy、recTotal、recPerPage、pageID', async () => {
    await listMine(new ZentaoClient(config()), 'bug');
    expect(fake.myWorkArgs).toEqual(['bug', 'assignedTo', 'id_desc', '0', '200', '1']);
    expect(fake.myBugCalls).toBe(0);
  });

  it('my-work 的参数顺序和服务端对不上时（pager 回显的每页条数不对），退回旧接口 my-bug', async () => {
    fake.myWorkHasParam = true;
    try {
      const { rows } = await listMine(new ZentaoClient(config()), 'bug');
      expect(rows.map((r) => r.id)).toEqual([101]);
      expect(fake.myBugCalls).toBe(1);
    } finally {
      fake.myWorkHasParam = false;
    }
  });

  it('会话失效（被跳到 showErrorNone）后自动重新登录一次', async () => {
    fake.loggedIn.clear();
    await new ZentaoClient(config()).view({ m: 'bug', f: 'view', args: [['bugID', 101]] });
    expect(fake.logins).toBe(2);
  });

  it('会话失效（返回 locate 登录页）后自动重新登录一次', async () => {
    fake.loggedIn.clear();
    await listMine(new ZentaoClient(config()), 'bug');
    expect(fake.logins).toBe(3);
  });

  it('单据不存在返回 NotFound', async () => {
    await expect(fetchTicket(new ZentaoClient(config()), 'bug', 999, { download: false, outDir: home, repos: {} })).rejects.toMatchObject({
      exitCode: ExitCode.NotFound,
    });
  });

  it('追加备注后回读确认', async () => {
    const r = await addComment(new ZentaoClient(config()), 'bug', 101, '**开发澄清**\n\n1. 是否只在无痕模式？');
    expect(r.actionId).toBeGreaterThan(0);
    const added = Object.values(fake.view.actions as Record<string, { comment: string }>).at(-1)!;
    expect(added.comment).toContain('<strong>开发澄清</strong>');
  });

  it('指派 Bug：按姓名找账号，备注随指派写入', async () => {
    try {
      const r = await assignBug(new ZentaoClient(config()), 101, '测试甲', '请后端协助排查');
      expect(r).toMatchObject({ assignedTo: 'tester1', assignedName: '测试甲' });
      const added = Object.values(fake.view.actions as Record<string, { action: string; comment: string }>).at(-1)!;
      expect(added).toMatchObject({ action: 'assigned', comment: expect.stringContaining('请后端协助排查') });
      await expect(assignBug(new ZentaoClient(config()), 101, '不存在的人')).rejects.toThrow(/没有账号或姓名/);
      await expect(assignBug(new ZentaoClient(config()), 101, 'constructor')).rejects.toThrow(/没有账号或姓名/);
      await expect(assignBug(new ZentaoClient(config()), 101, '测试甲', '  \n')).rejects.toThrow(/备注内容为空/);
    } finally {
      fake.view.bug.assignedTo = 'dev1';
    }
  });

  it('解决 Bug：默认指派回提出人，回读状态', async () => {
    const r = await resolveBug(new ZentaoClient(config()), 101, { resolution: 'fixed', build: 'trunk', comment: '已修复' });
    expect(r.status).toBe('resolved');
    expect(r.assignedTo).toBe('tester1');
    // 已解决的 Bug 不能再次解决
    await expect(resolveBug(new ZentaoClient(config()), 101, { resolution: 'fixed', build: 'trunk' })).rejects.toThrow(/只能解决激活状态/);
  });

  it('非默认的解决方案代码不加 custom 时在提交前拒绝', async () => {
    const before = Object.keys(fake.view.actions).length;
    for (const resolution of ['fixd', 'constructor']) {
      await expect(resolveBug(new ZentaoClient(config()), 101, { resolution, build: 'trunk' })).rejects.toThrow(/--custom/);
    }
    expect(Object.keys(fake.view.actions)).toHaveLength(before);
    // 加了 custom 就放行代码校验，接着才是状态校验；显式置为已解决，不依赖上一个用例
    fake.view.bug.status = 'resolved';
    await expect(resolveBug(new ZentaoClient(config()), 101, { resolution: 'fixd', build: 'trunk', custom: true })).rejects.toThrow(
      /只能解决激活状态/,
    );
  });

  it('只读模式在客户端拦截写操作和任意路由请求', async () => {
    const ro = new ZentaoClient({ ...config(), readonly: true });
    const before = Object.keys(fake.view.actions).length;
    await expect(addComment(ro, 'bug', 101, '不应写入')).rejects.toThrow(/只读模式/);
    await expect(ro.view({ m: 'bug', f: 'view', args: [['bugID', 101]] }, { unsafe: true })).rejects.toThrow(/只读模式/);
    expect(Object.keys(fake.view.actions).length).toBe(before);
  });

  it('重新登录后仍被跳到 showErrorNone 时报权限问题而不是会话失效', async () => {
    fake.loggedIn.clear();
    const originalAdd = fake.loggedIn.add.bind(fake.loggedIn);
    // 模拟"登录成功但账号没有任何产品权限"：登录后的 session 不被视为已登录
    fake.loggedIn.add = () => fake.loggedIn;
    try {
      await expect(new ZentaoClient(config()).view({ m: 'bug', f: 'view', args: [['bugID', 101]] })).rejects.toThrow(/没有可访问的产品/);
    } finally {
      fake.loggedIn.add = originalAdd;
    }
  });

  it('密码错误返回 Auth 退出码', async () => {
    const err = await new ZentaoClient({ ...config(), password: 'wrong' }).login().catch((e) => e);
    expect(err).toBeInstanceOf(ZentaoError);
    expect(err.exitCode).toBe(ExitCode.Auth);
  });
});
