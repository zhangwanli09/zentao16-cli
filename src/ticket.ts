import { join } from 'node:path';
import { AssetStore } from './assets.js';
import type { Downloader, Route } from './client.js';
import { resolveRepo, type RepoMap } from './config.js';
import { ExitCode, ZentaoError } from './errors.js';
import {
  ACCOUNT_FIELDS,
  ACTION,
  BUG_STATUS,
  BUG_TYPE,
  FIELD,
  label,
  LONG_FIELDS,
  RESOLUTION,
  STORY_STAGE,
  STORY_STATUS,
  str,
  TASK_STATUS,
  TASK_TYPE,
} from './labels.js';
import type {
  Id,
  ListRow,
  MapOrList,
  MetaField,
  RawAction,
  RawBug,
  RawFile,
  RawStory,
  RawTask,
  RawView,
  Ticket,
  TicketType,
  HistoryEntry,
} from './types.js';

export interface ViewClient extends Downloader {
  view<T>(route: Route): Promise<T>;
  webUrl(route: Route): string;
}

export interface FetchOptions {
  download: boolean;
  outDir: string;
  repos: RepoMap;
}

export const TYPE_LABEL: Record<TicketType, string> = { bug: 'Bug', story: '需求', task: '任务' };
export const TICKET_TYPES = Object.keys(TYPE_LABEL) as TicketType[];
const ID_PARAM: Record<TicketType, string> = { bug: 'bugID', story: 'storyID', task: 'taskID' };

export function viewRoute(type: TicketType, id: number): Route {
  return { m: type, f: 'view', args: [[ID_PARAM[type], id]] };
}

export function ticketUrl(client: ViewClient, type: TicketType, id: number): string {
  return client.webUrl(viewRoute(type, id));
}

/** 读取单据视图，单据不存在时抛出 NotFound；禅道明确提示"无权访问"时由 client 抛出 Auth */
export async function loadView(client: ViewClient, type: TicketType, id: number): Promise<RawView> {
  const view = await client.view<RawView>(viewRoute(type, id));
  const obj = view[type];
  if (!obj || typeof obj !== 'object') {
    throw new ZentaoError(`${TYPE_LABEL[type]} #${id} 不存在或无权查看`, ExitCode.NotFound);
  }
  return view;
}

export function toList<T>(value: MapOrList<T> | undefined | null): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : Object.values(value);
}

const isZero = (v: unknown): boolean => ['', '0', '0000-00-00', '0000-00-00 00:00:00'].includes(str(v));
const linkId = (v: unknown): string => (isZero(v) ? '' : str(v));
const pri = (v: unknown): string => (v ? `P${v}` : '');
const sev = (v: unknown): string => (v ? `S${v}` : '');
const joinNonEmpty = (values: unknown[]): string => values.map(str).filter(Boolean).join(' / ');
/** "#45 标题"，关联 ID 为空时返回空串 */
const link = (id: unknown, title?: unknown): string => {
  const linked = linkId(id);
  return linked && `#${linked} ${str(title)}`.trim();
};

class Context {
  constructor(
    readonly view: RawView,
    readonly assets: AssetStore,
  ) {}

  who = (account?: string): string => {
    const a = str(account);
    if (!a) return '';
    if (a === 'closed') return 'Closed';
    const name = this.view.users?.[a];
    return name && name !== a ? `${name}(${a})` : a;
  };

  builds = (ids?: string): string =>
    str(ids)
      .split(',')
      .filter(Boolean)
      .map((id) => (id === 'trunk' ? '主干' : (this.view.builds?.[id] ?? id)))
      .join('、');

  modulePath = (): string => (this.view.modulePath ?? []).map((m) => m.name).join(' / ');

  opened = (obj: { openedBy?: string; openedDate?: string }): string => `${this.who(obj.openedBy)} ${str(obj.openedDate)}`.trim();
}

function meta(fields: Array<[string, string, unknown]>): MetaField[] {
  return fields.filter(([, , v]) => !isZero(v)).map(([key, lbl, v]) => ({ key, label: lbl, value: str(v) }));
}

async function history(ctx: Context): Promise<HistoryEntry[]> {
  const actions = toList<RawAction>(ctx.view.actions).sort((a, b) => Number(a.id) - Number(b.id));
  const entries: HistoryEntry[] = [];
  for (const a of actions) {
    const action = a.action.toLowerCase();
    let extra = str(a.extra);
    if (action === 'resolved') extra = label(RESOLUTION, extra.split(',')[0]);
    else if (action === 'assigned') extra = ctx.who(extra);
    entries.push({
      date: a.date,
      actor: ctx.who(a.actor),
      action: label(ACTION, action),
      extra: extra || undefined,
      comment: (await ctx.assets.markdown(a.comment)) || undefined,
      changes: (a.history ?? []).map((h) => {
        const fmt = (v?: string) => (ACCOUNT_FIELDS.has(h.field) ? ctx.who(v) : str(v));
        return LONG_FIELDS.has(h.field)
          ? { field: label(FIELD, h.field), old: '', new: '（内容有修改）' }
          : { field: label(FIELD, h.field), old: fmt(h.old), new: fmt(h.new) };
      }),
    });
  }
  return entries;
}

function bugMeta(bug: RawBug, ctx: Context): MetaField[] {
  let status = label(BUG_STATUS, bug.status);
  if (bug.status === 'active') status += str(bug.confirmed) === '1' ? '（已确认）' : '（未确认）';
  return meta([
    ['status', '状态', status],
    ['severity', '严重程度', sev(bug.severity)],
    ['pri', '优先级', pri(bug.pri)],
    ['type', '类型', label(BUG_TYPE, bug.type)],
    ['product', '产品', ctx.view.product?.name],
    ['module', '模块', ctx.modulePath()],
    ['openedBuild', '影响版本', ctx.builds(bug.openedBuild)],
    ['env', '环境', joinNonEmpty([bug.os, bug.browser])],
    ['openedBy', '提出', ctx.opened(bug)],
    ['assignedTo', '指派给', ctx.who(bug.assignedTo)],
    ['deadline', '截止日期', bug.deadline],
    ['story', '相关需求', link(bug.story, bug.storyTitle)],
    ['task', '相关任务', link(bug.task, bug.taskName)],
    ['case', '来源用例', link(bug.case)],
    ['linkBug', '相关 Bug', bug.linkBug],
    ['resolution', '解决方案', bug.resolution && `${label(RESOLUTION, bug.resolution)}（${ctx.who(bug.resolvedBy)}，${ctx.builds(bug.resolvedBuild)}）`],
    ['keywords', '关键词', bug.keywords],
  ]);
}

function storyMeta(story: RawStory, ctx: Context): MetaField[] {
  const plan = typeof story.planTitle === 'object' ? Object.values(story.planTitle).join('、') : story.planTitle;
  return meta([
    ['status', '状态', label(STORY_STATUS, story.status)],
    ['stage', '阶段', label(STORY_STAGE, story.stage)],
    ['pri', '优先级', pri(story.pri)],
    ['estimate', '预计工时', story.estimate],
    ['product', '产品', ctx.view.product?.name],
    ['module', '模块', ctx.modulePath()],
    ['plan', '计划', plan],
    ['category', '类型', story.category],
    ['source', '来源', joinNonEmpty([story.source, story.sourceNote])],
    ['openedBy', '提出', ctx.opened(story)],
    ['assignedTo', '指派给', ctx.who(story.assignedTo)],
    ['version', '版本', story.version],
  ]);
}

function taskMeta(task: RawTask, ctx: Context): MetaField[] {
  const hours = [task.estimate, task.consumed, task.left].map((v) => str(v) || '0').join(' / ');
  return meta([
    ['status', '状态', label(TASK_STATUS, task.status)],
    ['type', '类型', label(TASK_TYPE, task.type)],
    ['pri', '优先级', pri(task.pri)],
    ['execution', '所属执行', ctx.view.execution?.name ?? task.executionName],
    ['module', '模块', ctx.modulePath()],
    ['story', '相关需求', link(task.story, task.storyTitle)],
    ['hours', '工时（预计/消耗/剩余）', `${hours} h`],
    ['openedBy', '创建', ctx.opened(task)],
    ['assignedTo', '指派给', ctx.who(task.assignedTo)],
    ['deadline', '截止日期', task.deadline],
  ]);
}

/** 拉取一张单据，下载图片/附件，返回规范化结果 */
export async function fetchTicket(client: ViewClient, type: TicketType, id: number, opts: FetchOptions): Promise<Ticket> {
  const view = await loadView(client, type, id);
  const obj = view[type]!;

  const files = new Map<string, RawFile>(toList<RawFile>(obj.files).map((f) => [str(f.id), f]));
  const assets = new AssetStore(client, join(opts.outDir, `${type}-${id}`), files, opts.download);
  const ctx = new Context(view, assets);

  let title: string;
  let metaFields: MetaField[];
  const sections: Ticket['sections'] = [];
  const section = async (heading: string, html?: string) => {
    const markdown = await assets.markdown(html);
    if (markdown) sections.push({ heading, markdown });
  };

  if (type === 'bug') {
    const bug = obj as RawBug;
    title = str(bug.title);
    metaFields = bugMeta(bug, ctx);
    await section('重现步骤', bug.steps);
  } else if (type === 'story') {
    const story = obj as RawStory;
    title = str(story.title);
    metaFields = storyMeta(story, ctx);
    await section('需求描述', story.spec);
    await section('验收标准', story.verify);
  } else {
    const task = obj as RawTask;
    title = str(task.name);
    metaFields = taskMeta(task, ctx);
    await section('任务描述', task.desc);
    await section('相关需求描述', task.storySpec);
    await section('相关需求验收标准', task.storyVerify);
  }

  const moduleIds = (view.modulePath ?? []).map((m) => str(m.id));
  return {
    type,
    id,
    title,
    url: ticketUrl(client, type, id),
    repo: resolveRepo(opts.repos, str(obj.product), moduleIds),
    meta: metaFields,
    sections,
    attachments: await assets.attachments(),
    history: await history(ctx),
    warnings: assets.warnings,
  };
}

interface RawListItem {
  id: Id;
  title?: string;
  name?: string;
  status?: string;
  pri?: Id;
  severity?: Id;
  openedBy?: string;
  openedDate?: string;
}

/** my 列表一次最多取回的条数 */
export const LIST_LIMIT = 200;

const LIST_KEY: Record<TicketType, string> = { bug: 'bugs', story: 'stories', task: 'tasks' };
const STATUS_LABEL: Record<TicketType, Record<string, string>> = { bug: BUG_STATUS, story: STORY_STATUS, task: TASK_STATUS };

/** 指派给我的单据。16.x 用"地盘-待处理"（my-work），取不到时退回旧的 my-bug/my-story/my-task */
export interface ListResult {
  rows: ListRow[];
  /** 服务端总条数大于本次取回条数时为 true（只取第一页，状态过滤在本地做） */
  truncated: boolean;
}

export async function listMine(client: ViewClient, type: TicketType, status?: string): Promise<ListResult> {
  const key = LIST_KEY[type];
  let data: Record<string, unknown>;
  try {
    // 16.5 的 my-work 没有 param 参数，PATH_INFO 只看位置，签名对不上时排序、分页会整体错位
    data = await client.view<Record<string, unknown>>({
      m: 'my',
      f: 'work',
      args: [
        ['mode', type],
        ['type', 'assignedTo'],
        ['orderBy', 'id_desc'],
        ['recTotal', 0],
        ['recPerPage', LIST_LIMIT],
        ['pageID', 1],
      ],
    });
    if (!data?.[key]) throw new ZentaoError('my-work 未返回列表');
    // 错位时禅道不报错，只能从 pager 回显的每页条数看出来，这时改用按名取参的旧接口
    const perPage = (data.pager as { recPerPage?: unknown } | null)?.recPerPage;
    if (perPage !== undefined && Number(perPage) !== LIST_LIMIT) throw new ZentaoError('my-work 的参数顺序与服务端不一致');
  } catch (e) {
    if (e instanceof ZentaoError && e.exitCode === ExitCode.Auth) throw e;
    data = await client.view<Record<string, unknown>>({ m: 'my', f: type, args: [['type', 'assignedTo']] });
  }

  const users = (data.users ?? {}) as Record<string, string>;
  const items = toList(data[key] as MapOrList<RawListItem>);
  const total = Number((data.pager as { recTotal?: unknown } | null)?.recTotal ?? items.length);
  const rows = items
    .filter((item) => !status || item.status === status)
    .map((item) => ({
      id: Number(item.id),
      title: str(item.title ?? item.name),
      status: label(STATUS_LABEL[type], item.status),
      pri: pri(item.pri),
      severity: type === 'bug' ? sev(item.severity) || undefined : undefined,
      openedBy: users[str(item.openedBy)] ?? str(item.openedBy),
      openedDate: str(item.openedDate).slice(0, 16),
    }));
  return { rows, truncated: total > items.length };
}
