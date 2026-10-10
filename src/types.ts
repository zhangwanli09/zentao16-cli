/** 禅道旧版 JSON 接口返回的原始结构（只声明用到的字段，数字字段在禅道里多为字符串） */

export type Id = string | number;
export type MapOrList<T> = Record<string, T> | T[];

export interface RawFile {
  id: Id;
  title?: string;
  extension?: string;
  size?: Id;
}

export interface RawHistory {
  field: string;
  old?: string;
  new?: string;
}

export interface RawAction {
  id: Id;
  actor: string;
  action: string;
  date: string;
  comment?: string;
  extra?: string;
  history?: RawHistory[];
}

interface RawCommon {
  id: Id;
  product?: Id;
  module?: Id;
  status?: string;
  pri?: Id;
  openedBy?: string;
  openedDate?: string;
  assignedTo?: string;
  files?: MapOrList<RawFile>;
}

export interface RawBug extends RawCommon {
  title?: string;
  severity?: Id;
  type?: string;
  steps?: string;
  confirmed?: Id;
  openedBuild?: string;
  resolution?: string;
  resolvedBy?: string;
  resolvedBuild?: string;
  story?: Id;
  storyTitle?: string;
  task?: Id;
  taskName?: string;
  case?: Id;
  deadline?: string;
  os?: string;
  browser?: string;
  keywords?: string;
  linkBug?: string;
}

export interface RawStory extends RawCommon {
  title?: string;
  spec?: string;
  verify?: string;
  stage?: string;
  estimate?: Id;
  source?: string;
  sourceNote?: string;
  category?: string;
  version?: Id;
  planTitle?: string | Record<string, string>;
}

export interface RawTask extends RawCommon {
  name?: string;
  desc?: string;
  type?: string;
  story?: Id;
  storyTitle?: string;
  storySpec?: string;
  storyVerify?: string;
  estimate?: Id;
  consumed?: Id;
  left?: Id;
  deadline?: string;
  executionName?: string;
}

export interface RawView {
  bug?: RawBug;
  story?: RawStory;
  task?: RawTask;
  product?: { name?: string };
  execution?: { name?: string };
  modulePath?: Array<{ id: Id; name: string }>;
  users?: Record<string, string>;
  actions?: MapOrList<RawAction>;
  builds?: Record<string, string>;
}

/** CLI 输出的规范化结构（--json 时原样输出） */

export type TicketType = 'bug' | 'story' | 'task';

export interface MetaField {
  key: string;
  label: string;
  value: string;
}

export interface Attachment {
  id: string;
  title: string;
  size?: number;
  path?: string;
  note?: string;
}

export interface HistoryEntry {
  date: string;
  actor: string;
  action: string;
  extra?: string;
  comment?: string;
  changes: Array<{ field: string; old: string; new: string }>;
}

export interface Ticket {
  type: TicketType;
  id: number;
  title: string;
  url: string;
  repo?: string;
  meta: MetaField[];
  sections: Array<{ heading: string; markdown: string }>;
  attachments: Attachment[];
  history: HistoryEntry[];
  warnings: string[];
}

export interface ListRow {
  id: number;
  title: string;
  status: string;
  pri: string;
  severity?: string;
  openedBy: string;
  openedDate: string;
}
