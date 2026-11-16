import type { Route } from './client.js';
import { ZentaoError } from './errors.js';
import { label, BUG_STATUS, BUG_TYPE, RESOLUTION, RESOLUTION_CODES } from './labels.js';
import { decodeAttr, htmlToMarkdown } from './render.js';
import { loadView, ticketUrl, toList, type ViewClient } from './ticket.js';
import type { RawAction, RawBug, RawView, TicketType } from './types.js';

export interface WriteClient extends ViewClient {
  post(route: Route, form: Record<string, string>): Promise<string>;
}

function now(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 禅道备注是富文本，把 agent 写的 Markdown 转成 HTML；未提供时为空串，提供了却是空白则报错 */
async function commentHtml(md: string | undefined): Promise<string> {
  if (md === undefined) return '';
  if (!md.trim()) throw new ZentaoError('备注内容为空');
  // 按需加载，不写备注的命令不必付出 marked 的启动开销
  const { marked } = await import('marked');
  return marked.parse(md, { gfm: true, breaks: true });
}

const actionIds = (view: RawView) => new Set(toList<RawAction>(view.actions).map((a) => String(a.id)));

/** 写操作后新增的历史记录，用于回读确认 */
const newActions = (before: Set<string>, after: RawView) => toList<RawAction>(after.actions).filter((a) => !before.has(String(a.id)));

export async function addComment(client: WriteClient, type: TicketType, id: number, markdown: string) {
  const html = await commentHtml(markdown);
  const before = actionIds(await loadView(client, type, id));

  await client.post({ m: 'action', f: 'comment', args: [['objectType', type], ['objectID', id]] }, { actioncomment: html });

  // 回读确认备注确实写进去了
  const added = newActions(before, await loadView(client, type, id)).find((a) => a.action.toLowerCase() === 'commented');
  if (!added) throw new ZentaoError('提交后在历史记录中没有找到新备注，请到禅道页面确认');
  return { type, id, actionId: Number(added.id), url: ticketUrl(client, type, id) };
}

/** 账号或姓名 → 账号；姓名重名时要求改用账号 */
function resolveAccount(users: Record<string, string>, who: string): string {
  if (Object.hasOwn(users, who) && users[who]) return who;
  const matches = Object.keys(users).filter((account) => account && users[account] === who);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new ZentaoError(`有多个叫"${who}"的用户（${matches.join('、')}），请改用账号指定`);
  throw new ZentaoError(`禅道中没有账号或姓名为"${who}"的用户`);
}

/** 指派 Bug，可同时写备注。没有 action-comment 权限的账号也能通过指派表单写备注 */
export async function assignBug(client: WriteClient, id: number, who: string, comment?: string) {
  who = who.trim();
  if (!who) throw new ZentaoError('请用 --user 指定账号或姓名');
  const html = await commentHtml(comment);
  const view = await loadView(client, 'bug', id);
  const users = view.users ?? {};
  const assignedTo = resolveAccount(users, who);
  const before = actionIds(view);

  await client.post({ m: 'bug', f: 'assignTo', args: [['bugID', id]] }, { assignedTo, status: String(view.bug!.status ?? ''), comment: html });

  const after = await loadView(client, 'bug', id);
  const current = after.bug!.assignedTo;
  if (current !== assignedTo) throw new ZentaoError(`提交后 Bug #${id} 仍指派给 ${current}，请到禅道页面确认`);
  if (html && !newActions(before, after).some((a) => a.comment)) throw new ZentaoError('已指派，但历史记录中没有找到新备注，请到禅道页面确认');
  return { id, assignedTo, assignedName: users[assignedTo], url: ticketUrl(client, 'bug', id) };
}

export interface EditBugOptions {
  title?: string;
  /** 重现步骤，Markdown；替换整段正文 */
  steps?: string;
  pri?: number;
  severity?: number;
  type?: string;
  os?: string;
  browser?: string;
  keywords?: string;
  /** YYYY-MM-DD，空字符串清除截止日期 */
  deadline?: string;
  comment?: string;
  custom?: boolean;
}

const EDIT_FIELDS = ['title', 'steps', 'pri', 'severity', 'type', 'os', 'browser', 'keywords', 'deadline'] as const;

// 16.5 bugModel::update 会给未提交的关联字段填 0/空值，并根据解决/关闭字段重新推导状态。
// 必须带回这些原值；只发送用户修改的字段会丢失关联，甚至重新激活已解决的 Bug。
// https://github.com/easysoft/zentaopms/blob/zentaopms_16.5/module/bug/model.php
const EDIT_REQUIRED_ORIGINALS = [
  'product', 'module', 'execution', 'story', 'task', 'branch', 'plan', 'duplicateBug',
  'openedBuild', 'deadline', 'resolvedDate', 'resolution', 'resolvedBy', 'closedBy',
  'closedDate', 'assignedTo', 'linkBug', 'lastEditedDate',
] as const satisfies readonly (keyof RawBug)[];

// 只回传编辑表单的字段，避免把视图附带的名称、附件和其他只读数据提交给数据库。
const EDIT_FORM_FIELDS = [
  ...EDIT_REQUIRED_ORIGINALS, 'project', 'title', 'color', 'type', 'severity', 'pri',
  'os', 'browser', 'keywords', 'mailto', 'feedbackBy', 'notifyEmail', 'resolvedBuild',
  'testtask', 'case',
] as const satisfies readonly (keyof RawBug)[];

function validateBugEdit(opts: EditBugOptions) {
  const fields = EDIT_FIELDS.filter((field) => opts[field] !== undefined);
  if (!fields.length && opts.comment === undefined) throw new ZentaoError('请指定要编辑的字段，或用 --message / --file 提供备注');
  if (opts.title !== undefined && !opts.title.trim()) throw new ZentaoError('Bug 标题不能为空');
  if (opts.steps !== undefined && !opts.steps.trim()) throw new ZentaoError('重现步骤不能为空');
  if (opts.pri !== undefined && (!Number.isInteger(opts.pri) || opts.pri < 0 || opts.pri > 4)) {
    throw new ZentaoError('优先级必须是 0–4 的整数');
  }
  if (opts.severity !== undefined && (!Number.isInteger(opts.severity) || opts.severity < 1 || opts.severity > 4)) {
    throw new ZentaoError('严重程度必须是 1–4 的整数');
  }
  if (opts.type !== undefined && (!/^\w+$/.test(opts.type) || (!opts.custom && !Object.hasOwn(BUG_TYPE, opts.type)))) {
    throw new ZentaoError(`无效的 Bug 类型：${opts.type}。默认代码：${Object.keys(BUG_TYPE).join('、')}；自定义代码需加 --custom`);
  }
  if (opts.deadline) {
    const date = new Date(`${opts.deadline}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.deadline) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== opts.deadline) {
      throw new ZentaoError('截止日期必须是有效的 YYYY-MM-DD，空字符串表示清除');
    }
  }
  return fields;
}

function buildBugEditForm(bug: RawBug, comment: string): Record<string, string> {
  const missing = EDIT_REQUIRED_ORIGINALS.filter((field) => bug[field] === undefined || bug[field] === null);
  if (missing.length) throw new ZentaoError(`编辑表单缺少原始字段（${missing.join('、')}），已停止提交以免覆盖数据`);
  const form: Record<string, string> = { comment };
  // 正文不在 EDIT_FORM_FIELDS 中，未修改时不回传，保留原始富文本与附件引用。
  for (const field of EDIT_FORM_FIELDS) {
    // 禅道 fixer 会对普通字段 htmlspecialchars；还原一次，防止 &amp; 等被重复编码。
    if (bug[field] !== undefined) form[field] = decodeAttr(String(bug[field]));
  }
  for (const field of ['resolvedDate', 'closedDate'] as const) {
    if (form[field].startsWith('0000-00-00')) form[field] = '';
  }
  return form;
}

export async function editBug(client: WriteClient, id: number, opts: EditBugOptions) {
  const fields = validateBugEdit(opts);
  const comment = await commentHtml(opts.comment);
  if (!fields.length) {
    // 16.5 bug::edit($bugID, $comment = false)：comment=1 时只创建备注，跳过字段更新和附件上传。
    // 使用 bug-edit 权限，无需 action-comment 权限，也不必回传原有字段。
    const before = actionIds(await loadView(client, 'bug', id));
    await client.post({ m: 'bug', f: 'edit', args: [['bugID', id], ['comment', 1]] }, { comment });
    const added = newActions(before, await loadView(client, 'bug', id)).find(
      (a) => a.action.toLowerCase() === 'commented' && a.comment,
    );
    if (!added) throw new ZentaoError('提交后在历史记录中没有找到新备注，请到禅道页面确认');
    return { id, fields, url: ticketUrl(client, 'bug', id) };
  }
  // edit 视图与网页编辑表单一致，不会像 view 那样给正文图片附加显示尺寸。
  const route: Route = { m: 'bug', f: 'edit', args: [['bugID', id]] };
  const view = await client.view<RawView>(route);
  const bug = view.bug;
  if (!bug) throw new ZentaoError(`无法读取 Bug #${id} 的编辑表单，请检查单据和编辑权限`);
  const form = buildBugEditForm(bug, comment);
  for (const field of fields) form[field] = String(opts[field]);
  if (opts.steps !== undefined) {
    const { marked } = await import('marked');
    form.steps = await marked.parse(opts.steps, { gfm: true, breaks: true });
  }
  if (opts.deadline === '') form.deadline = '0000-00-00';
  const before = actionIds(view);
  await client.post(route, form);

  const after = await client.view<RawView>(route);
  const updatedBug = after.bug;
  if (!updatedBug) throw new ZentaoError('提交后无法读取 Bug，请到禅道页面确认');
  const mismatch = fields.filter((field) => {
    if (field === 'steps') return false; // 服务端会过滤、规范化 HTML，用字段历史确认正文修改。
    const actual = decodeAttr(String(updatedBug[field] ?? ''));
    if (field === 'deadline' && !opts.deadline) return actual !== '' && !actual.startsWith('0000-00-00');
    return actual !== form[field];
  });
  const added = newActions(before, after);
  if (opts.steps !== undefined && updatedBug.steps !== form.steps) {
    const recordedChange = updatedBug.steps !== bug.steps && added.some((a) => a.history?.some((h) => h.field === 'steps'));
    if (!recordedChange) {
      const savedMarkdown = await htmlToMarkdown(updatedBug.steps);
      const submittedMarkdown = await htmlToMarkdown(form.steps);
      if (savedMarkdown !== submittedMarkdown) mismatch.push('steps');
    }
  }
  if (updatedBug.status !== bug.status) throw new ZentaoError('提交后 Bug 状态发生变化，请到禅道页面确认');
  if (mismatch.length) throw new ZentaoError(`提交后字段未按预期保存（${mismatch.join('、')}），请到禅道页面确认`);
  if (comment && !added.some((a) => a.comment)) throw new ZentaoError('已编辑，但历史记录中没有找到新备注，请到禅道页面确认');
  return { id, fields, url: ticketUrl(client, 'bug', id) };
}

export interface ResolveOptions {
  resolution: string;
  build: string;
  assign?: string;
  duplicate?: number;
  comment?: string;
  /** 允许使用不在默认列表里的解决方案代码（禅道里自定义过的） */
  custom?: boolean;
}

export async function resolveBug(client: WriteClient, id: number, opts: ResolveOptions) {
  // 禅道不校验 resolution 是否在列表里，拼错的代码会被原样存下，所以非默认代码要显式确认
  if (!opts.custom && !Object.hasOwn(RESOLUTION, opts.resolution)) {
    throw new ZentaoError(
      `${opts.resolution} 不是禅道默认的解决方案代码（${RESOLUTION_CODES}）。如果是在禅道里自定义过的，请加 --custom`,
    );
  }
  if (opts.resolution === 'duplicate' && !opts.duplicate) throw new ZentaoError('解决方案为 duplicate 时必须指定 --duplicate <bugId>');
  if (opts.resolution !== 'duplicate' && opts.duplicate) throw new ZentaoError('只有解决方案为 duplicate 时才能指定 --duplicate');
  const comment = await commentHtml(opts.comment);
  const bug = (await loadView(client, 'bug', id)).bug!;
  if (bug.status !== 'active') {
    throw new ZentaoError(`Bug #${id} 当前状态为"${label(BUG_STATUS, bug.status)}"，只能解决激活状态的 Bug`);
  }

  const form: Record<string, string> = {
    resolution: opts.resolution,
    resolvedBuild: opts.build,
    resolvedDate: now(),
    assignedTo: opts.assign ?? String(bug.openedBy ?? ''),
    comment,
  };
  if (opts.duplicate) form.duplicateBug = String(opts.duplicate);

  await client.post({ m: 'bug', f: 'resolve', args: [['bugID', id]] }, form);

  const after = (await loadView(client, 'bug', id)).bug!;
  if (after.status !== 'resolved') {
    throw new ZentaoError(`提交后 Bug #${id} 状态仍为"${label(BUG_STATUS, after.status)}"，请到禅道页面确认（可能缺少必填字段）`);
  }
  return {
    id,
    status: after.status,
    resolution: after.resolution,
    assignedTo: after.assignedTo,
    url: ticketUrl(client, 'bug', id),
  };
}
