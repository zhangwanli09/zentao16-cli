import { describe, expect, it } from 'vitest';
import { assertPostOk, buildUrl, parseLegacyResponse, validateBaseUrl } from '../src/client.js';
import { ExitCode, RetryableAuthError, SessionExpiredError, ZentaoError } from '../src/errors.js';

describe('parseLegacyResponse', () => {
  it('解析字符串形式的 data', () => {
    const raw = String.fromCharCode(0xfeff) + JSON.stringify({ status: 'success', data: JSON.stringify({ bug: { id: '1' } }) });
    expect(parseLegacyResponse(raw)).toEqual({ bug: { id: '1' } });
  });

  it('status 不是 success 时抛出可重试错误', () => {
    expect(() => parseLegacyResponse('{"status":"failed","reason":"未登录"}')).toThrow(RetryableAuthError);
  });

  it('跳转登录页视为会话失效', () => {
    expect(() => parseLegacyResponse("<script>parent.location='/zentao/user-login-L3plbnRhby8=.html'</script>")).toThrow(
      SessionExpiredError,
    );
  });

  it('忽略 JSON 后追加的脚本', () => {
    const raw = JSON.stringify({ status: 'success', data: JSON.stringify({ tasks: [] }) }) + '<script>var a = "}";</script>';
    expect(parseLegacyResponse(raw)).toEqual({ tasks: [] });
  });

  const wrap = (d: unknown) => JSON.stringify({ status: 'success', data: JSON.stringify(d) });

  it('data 里是登录跳转视为会话失效，result=fail 的"不存在"映射为 NotFound', () => {
    expect(() => parseLegacyResponse(wrap({ locate: 'http://x/zentao/user-login-abc.json' }) + wrap({ x: 1 }))).toThrow(SessionExpiredError);
    expect(() => parseLegacyResponse(wrap({ result: 'fail', message: '抱歉，您访问的对象不存在！' }))).toThrow(
      expect.objectContaining({ exitCode: ExitCode.NotFound }),
    );
  });

  it('"无权访问"提示映射为 Auth', () => {
    // 真实 16.5 环境：没有所属迭代的权限时，task-view 返回这段 data
    expect(() => parseLegacyResponse(wrap({ result: 'fail', message: '您无权访问该迭代！' }))).toThrow(
      expect.objectContaining({ exitCode: ExitCode.Auth }),
    );
  });

  it('"不存在"提示映射为 NotFound', () => {
    try {
      parseLegacyResponse("<script>alert('您访问的对象不存在！');history.back()</script>");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ZentaoError);
      expect((e as ZentaoError).exitCode).toBe(ExitCode.NotFound);
    }
  });
});

describe('assertPostOk', () => {
  it('成功的跳转脚本不报错', () => {
    expect(() => assertPostOk("<script>parent.location.reload()</script>")).not.toThrow();
    expect(() => assertPostOk('{"result":"success","message":"保存成功"}')).not.toThrow();
  });

  it('result=fail 或 alert 报错', () => {
    expect(() => assertPostOk('{"result":"fail","message":{"resolvedBuild":["必填"]}}')).toThrow(/resolvedBuild/);
    expect(() => assertPostOk("<script>alert('解决版本不能为空')</script>")).toThrow(/解决版本不能为空/);
  });

  it('result=fail 的"无权访问"提示同样映射为 Auth', () => {
    expect(() => assertPostOk('{"result":"fail","message":"您无权访问该迭代！"}')).toThrow(
      expect.objectContaining({ exitCode: ExitCode.Auth }),
    );
  });

  it('跳到无权限页报权限问题', () => {
    // 真实 16.x 环境：账号没有备注权限时 HTTP 200 返回这段脚本
    const page = "<html><meta charset='utf-8'/><style>body{background:white}</style><script>self.location='/zentao/user-deny-action-comment.html';\n\n</script>";
    expect(() => assertPostOk(page)).toThrow(/没有 action-comment 的访问权限/);
  });
});

describe('validateBaseUrl', () => {
  it('目录地址原样使用，只补结尾的 /；dir 为 index.php 所在目录', () => {
    const ok = (url: string, href: string, dir = href) => expect(validateBaseUrl(url)).toEqual({ href, dir });
    ok('http://pm.example.com/zentao', 'http://pm.example.com/zentao/');
    ok('http://pm.example.com/zentao/', 'http://pm.example.com/zentao/');
    ok('https://pm.example.com', 'https://pm.example.com/');
    ok('http://10.0.0.8:8080/zentao-v16.5', 'http://10.0.0.8:8080/zentao-v16.5/');
    // 目录名以 index.php 结尾不算入口
    ok('http://pm.example.com/myindex.php/', 'http://pm.example.com/myindex.php/');
    // 旧版本就支持的写法：没开 URL 重写时走 index.php/bug-view-1.json
    ok('http://pm.example.com/zentao/index.php', 'http://pm.example.com/zentao/index.php/', 'http://pm.example.com/zentao/');
    ok('http://pm.example.com/zentao/index.php//', 'http://pm.example.com/zentao/index.php/', 'http://pm.example.com/zentao/');
    ok('http://pm.example.com/zentao/index.php/.', 'http://pm.example.com/zentao/index.php/./', 'http://pm.example.com/zentao/');
    ok('http://10.0.0.8:8080/index.php', 'http://10.0.0.8:8080/index.php/', 'http://10.0.0.8:8080/');
  });

  it('页面地址报配置错误，并给出应填的目录', () => {
    for (const url of [
      'http://pm.example.com/zentao/index.php?m=my&f=index',
      'http://pm.example.com/zentao/my.html#app=my',
      'http://pm.example.com/zentao/bug-view-101.html',
      'http://pm.example.com/zentao/?m=my',
    ]) {
      expect(() => validateBaseUrl(url)).toThrow(
        expect.objectContaining({ exitCode: ExitCode.Auth, message: expect.stringMatching(/请改为 http:\/\/pm\.example\.com\/zentao\/$/) }),
      );
    }
    // 服务器走 index.php/ 时建议保留到 index.php
    expect(() => validateBaseUrl('http://pm.example.com/zentao/index.php/bug-view-101.html')).toThrow(
      /请改为 http:\/\/pm\.example\.com\/zentao\/index\.php$/,
    );
  });

  it('缺少协议或带账号密码时报配置错误，且不泄露密码', () => {
    expect(() => validateBaseUrl('pm.example.com/zentao')).toThrow(expect.objectContaining({ exitCode: ExitCode.Auth }));
    expect(() => validateBaseUrl('localhost:8080/zentao')).toThrow(expect.objectContaining({ exitCode: ExitCode.Auth }));
    expect(() => validateBaseUrl('http://u:p@pm.example.com/zentao/')).toThrow(/不要包含账号密码/);
    expect(() => validateBaseUrl('admin:secret@pm.example.com/zentao')).toThrow(/\*\*\*@pm\.example\.com/);
    expect(() => validateBaseUrl('admin:secret@pm.example.com/zentao')).not.toThrow(/secret/);
  });
});

describe('buildUrl', () => {
  const route = { m: 'bug', f: 'view', args: [['bugID', 101]] as Array<[string, number]>, t: 'json' };

  it('base 是目录时按两种模式拼地址', () => {
    const base = validateBaseUrl('http://pm.example.com/zentao/');
    expect(buildUrl(base, 'PATH_INFO', route)).toBe('http://pm.example.com/zentao/bug-view-101.json');
    expect(buildUrl(base, 'GET', route)).toBe('http://pm.example.com/zentao/index.php?m=bug&f=view&t=json&bugID=101');
  });

  it('base 填到 index.php 时，PATH_INFO 走 index.php/，GET 不重复拼 index.php', () => {
    for (const url of ['http://pm.example.com/zentao/index.php', 'http://pm.example.com/zentao/index.php/.']) {
      const base = validateBaseUrl(url);
      expect(buildUrl(base, 'PATH_INFO', route)).toBe('http://pm.example.com/zentao/index.php/bug-view-101.json');
      expect(buildUrl(base, 'GET', route)).toBe('http://pm.example.com/zentao/index.php?m=bug&f=view&t=json&bugID=101');
    }
  });
});
