import type { Route } from './client.js';
import { ZentaoError } from './errors.js';
import { label, BUG_STATUS, RESOLUTION, RESOLUTION_CODES } from './labels.js';
import { loadView, ticketUrl, toList, type ViewClient } from './ticket.js';
import type { RawAction, RawView, TicketType } from './types.js';

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
