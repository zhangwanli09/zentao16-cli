import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { editBug, type EditBugOptions } from '../src/actions.js';
import type { RawView } from '../src/types.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/bug-view.json', import.meta.url), 'utf8')) as RawView;

function editView(): RawView {
  const view = structuredClone(fixture);
  Object.assign(view.bug!, {
    branch: '2', project: '10', execution: '20', plan: '30', duplicateBug: '0',
    resolvedDate: '', resolvedBy: '', closedBy: '', closedDate: '',
    resolvedBuild: '', linkBug: '102,103', mailto: 'tester1,dev1',
    lastEditedDate: '2026-11-16 12:30:00',
  });
  return view;
}

function setup(before = editView(), after = structuredClone(before)) {
  const client = {
    view: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after),
    post: vi.fn().mockResolvedValue(''),
    download: vi.fn(),
    webUrl: () => 'http://zentao.local/bug-view-101.html',
  };
  return { client, before, after };
}

describe('编辑 Bug（禅道开源版 16.5）', () => {
  it('修改标题时保留关联、版本、抄送、生命周期和并发检查字段，不回传正文/视图数据', async () => {
    const { client, before, after } = setup();
    after.bug!.title = '新的标题';
    const result = await editBug(client, 101, { title: '新的标题' });
    expect(result).toEqual({ id: 101, fields: ['title'], url: 'http://zentao.local/bug-view-101.html' });
    const [route, form] = client.post.mock.calls[0];
    expect(route).toEqual({ m: 'bug', f: 'edit', args: [['bugID', 101]] });
    expect(client.view).toHaveBeenNthCalledWith(1, route);
    expect(client.view).toHaveBeenNthCalledWith(2, route);
    expect(form).toMatchObject({
      title: '新的标题', product: '3', module: '12', branch: '2', project: '10', execution: '20',
      story: '45', task: '0', plan: '30', duplicateBug: '0', openedBuild: '7,trunk',
      linkBug: '102,103', mailto: 'tester1,dev1', assignedTo: 'dev1',
      lastEditedDate: '2026-11-16 12:30:00', resolution: '', resolvedDate: '',
    });
    expect(form).not.toHaveProperty('steps');
    expect(form).not.toHaveProperty('id');
    expect(form).not.toHaveProperty('files');
    expect(form).not.toHaveProperty('storyTitle');
    expect(before.bug!.title).toBe(fixture.bug!.title);
  });

  it.each(['resolved', 'closed'])('编辑 %s Bug 保留解决/关闭信息与状态', async (status) => {
    const before = editView();
    Object.assign(before.bug!, {
      status, resolution: 'fixed', resolvedBy: 'dev1', resolvedBuild: '7',
      resolvedDate: '2026-11-15 10:00:00', closedBy: status === 'closed' ? 'tester1' : '',
      closedDate: status === 'closed' ? '2026-11-16 11:00:00' : '', assignedTo: status === 'closed' ? 'closed' : 'tester1',
    });
    const { client, after } = setup(before);
    after.bug!.pri = '1';
    await editBug(client, 101, { pri: 1 });
    expect(client.post.mock.calls[0][1]).toMatchObject({
      resolution: 'fixed', resolvedBy: 'dev1', resolvedBuild: '7', resolvedDate: '2026-11-15 10:00:00',
      closedBy: before.bug!.closedBy, closedDate: before.bug!.closedDate, assignedTo: before.bug!.assignedTo,
    });
  });

  it('普通字段先还原 HTML 转义，防止未修改的标题/关键词重复编码', async () => {
    const before = editView();
    Object.assign(before.bug!, { title: 'A &amp; B &lt;x&gt; &#039;q&#039;', keywords: '&quot;test&quot;' });
    const { client, after } = setup(before);
    after.bug!.pri = '0';
    await editBug(client, 101, { pri: 0 });
    expect(client.post.mock.calls[0][1]).toMatchObject({ title: "A & B <x> 'q'", keywords: '"test"', pri: '0' });
  });

  it('支持批量修改字段，正文和附加备注分别转换为 HTML', async () => {
    const { client, after } = setup();
    Object.assign(after.bug!, {
      steps: '<p>新步骤<br />检查结果</p>', pri: '2', severity: '1', type: 'performance',
      os: 'linux', browser: 'firefox', keywords: '回归', deadline: '2026-11-30',
    });
    after.actions = [{ id: '9999', actor: 'dev1', action: 'edited', date: '', comment: '<p>补充说明</p>', history: [{ field: 'steps' }] }];
    await editBug(client, 101, {
      steps: '新步骤\n检查结果', pri: 2, severity: 1, type: 'performance',
      os: 'linux', browser: 'firefox', keywords: '回归', deadline: '2026-11-30', comment: '**补充说明**',
    });
    expect(client.post.mock.calls[0][1]).toMatchObject({
      steps: '<p>新步骤<br>检查结果</p>\n', comment: '<p><strong>补充说明</strong></p>\n',
      pri: '2', severity: '1', type: 'performance', deadline: '2026-11-30',
    });
  });

  it('允许重复提交已保存的正文，不要求出现新的编辑历史', async () => {
    const before = editView();
    before.bug!.steps = '<p>新步骤</p>';
    const { client } = setup(before);
    await expect(editBug(client, 101, { steps: '新步骤' })).resolves.toMatchObject({ fields: ['steps'] });
  });

  it('可清除环境、关键词和截止日期，并兼容零日期', async () => {
    const { client, before, after } = setup();
    before.bug!.resolvedDate = '0000-00-00 00:00:00';
    before.bug!.closedDate = '0000-00-00';
    Object.assign(after.bug!, { os: '', browser: '', keywords: '', deadline: '0000-00-00' });
    await editBug(client, 101, { os: '', browser: '', keywords: '', deadline: '' });
    expect(client.post.mock.calls[0][1]).toMatchObject({ os: '', browser: '', keywords: '', deadline: '0000-00-00', resolvedDate: '', closedDate: '' });
  });

  it.each<EditBugOptions>([
    {}, { comment: '' }, { comment: ' ' }, { custom: true }, { title: ' ' }, { steps: '\n' },
    { pri: -1 }, { pri: 5 }, { pri: 1.5 }, { severity: 0 }, { severity: 5 },
    { type: 'typo' }, { type: '' }, { type: 'bad-code', custom: true },
    { deadline: '2026-02-29' }, { deadline: '2026-13-01' }, { deadline: '2026-1-1' },
    { title: '新标题', comment: ' ' },
  ])('无效参数 %j 在请求前拒绝', async (opts) => {
    const { client } = setup();
    await expect(editBug(client, 101, opts)).rejects.toThrow();
    expect(client.view).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
  });

  it('显式 --custom 允许自定义类型', async () => {
    const { client, after } = setup();
    after.bug!.type = 'team_type';
    await editBug(client, 101, { type: 'team_type', custom: true });
    expect(client.post.mock.calls[0][1].type).toBe('team_type');
  });

  it('仅备注走 bug-edit 的 comment=1 分支，不提交原有字段，也不要求编辑表单字段齐全', async () => {
    const { client, after } = setup(structuredClone(fixture));
    after.actions = [{ id: '9999', actor: 'dev1', action: 'Commented', date: '', comment: '<p>补充说明</p>' }];
    await expect(editBug(client, 101, { comment: '**补充说明**' })).resolves.toMatchObject({ id: 101, fields: [] });
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenCalledWith(
      { m: 'bug', f: 'edit', args: [['bugID', 101], ['comment', 1]] },
      { comment: '<p><strong>补充说明</strong></p>\n' },
    );
    expect(client.view).toHaveBeenNthCalledWith(1, { m: 'bug', f: 'view', args: [['bugID', 101]] });
    expect(client.view).toHaveBeenNthCalledWith(2, { m: 'bug', f: 'view', args: [['bugID', 101]] });
  });

  it('仅备注提交没有新增备注时回读检查失败，不重试写入', async () => {
    const { client } = setup();
    await expect(editBug(client, 101, { comment: '未写入的备注' })).rejects.toThrow(/没有找到新备注/);
    expect(client.post).toHaveBeenCalledTimes(1);
  });

  it('编辑视图缺少原始字段时停止提交，避免默认值清空关联', async () => {
    const { client } = setup(structuredClone(fixture));
    await expect(editBug(client, 101, { title: '新标题' })).rejects.toThrow(/缺少原始字段/);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('提交错误（如并发修改）不重试，不报告成功', async () => {
    const { client } = setup();
    client.post.mockRejectedValue(new Error('该记录已被他人修改'));
    await expect(editBug(client, 101, { title: '新标题' })).rejects.toThrow(/他人修改/);
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.view).toHaveBeenCalledTimes(1);
  });

  it.each<EditBugOptions>([{ title: '没有保存的标题' }, { steps: '没有保存的正文' }])('提交未保存 %j 时回读检查失败', async (opts) => {
    const { client } = setup();
    await expect(editBug(client, 101, opts)).rejects.toThrow(/未按预期保存/);
  });

  it('发现意外状态变化时提示到页面确认', async () => {
    const { client, after } = setup();
    after.bug!.status = 'resolved';
    await expect(editBug(client, 101, { pri: 3 })).rejects.toThrow(/状态发生变化/);
  });

  it('附加备注未写入时不报告完全成功', async () => {
    const { client } = setup();
    await expect(editBug(client, 101, { pri: 3, comment: '未写入的备注' })).rejects.toThrow(/没有找到新备注/);
  });
});
