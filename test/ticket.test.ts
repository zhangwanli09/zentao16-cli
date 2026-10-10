import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Route } from '../src/client.js';
import { ticketToMarkdown } from '../src/markdown.js';
import { fetchTicket, type ViewClient } from '../src/ticket.js';

const view = JSON.parse(readFileSync(new URL('./fixtures/bug-view.json', import.meta.url), 'utf8'));

class FakeClient implements ViewClient {
  downloads: Array<{ route: Route; dest: string }> = [];
  async view<T>(): Promise<T> {
    return view as T;
  }
  async download(route: Route, dest: string): Promise<void> {
    this.downloads.push({ route, dest });
  }
  webUrl(route: Route): string {
    return `http://zentao.local/${route.m}-${route.f}.html`;
  }
}

describe('fetchTicket(bug)', () => {
  it('规范化字段、下载图片、按时间排序历史', async () => {
    const client = new FakeClient();
    const outDir = mkdtempSync(join(tmpdir(), 'zentao-ticket-'));
    const t = await fetchTicket(client, 'bug', 101, {
      download: true,
      outDir,
      repos: { products: { '3': 'D:/repo/member' }, modules: { '10': 'D:/repo/member/account' } },
    });

    const meta = Object.fromEntries(t.meta.map((m) => [m.key, m.value]));
    expect(meta.status).toBe('激活（未确认）');
    expect(meta.module).toBe('账号 / 登录');
    expect(meta.openedBuild).toBe('v2.3.0、主干');
    expect(meta.assignedTo).toBe('开发乙(dev1)');
    expect(meta.story).toBe('#45 登录安全加固');
    expect(meta).not.toHaveProperty('deadline');
    expect(meta).not.toHaveProperty('task');

    // 模块映射优先于产品映射
    expect(t.repo).toBe('D:/repo/member/account');

    expect(t.sections[0].markdown).toMatch(/!\[截图\]\(\S*bug-101\/55-截图_1\.png\)/);
    expect(t.attachments.map((a) => a.path?.split('/').slice(-2).join('/'))).toEqual(['bug-101/55-截图_1.png', 'bug-101/56-console.log']);
    // 下载根目录自动加 .gitignore
    expect(readFileSync(join(outDir, '.gitignore'), 'utf8')).toBe('*\n');
    // 正文图片和附件是同一个文件，只下载一次；备注里的图片单独下载
    expect(client.downloads.map((d) => d.route.args?.[0][1])).toEqual(['55', '56', '57']);

    expect(t.history.map((h) => h.action)).toEqual(['创建', '指派', '备注']);
    expect(t.history[1].changes[0]).toEqual({ field: '指派给', old: 'pm1', new: '开发乙(dev1)' });
    expect(t.history[2].comment).toContain('只在 Chrome 无痕模式下出现');

    const md = ticketToMarkdown(t);
    expect(md).toMatch(/^# Bug #101：登录页验证码不刷新/);
    expect(md).toContain('- **对应仓库**：D:/repo/member/account');
    rmSync(outDir, { recursive: true, force: true });
  });
});
