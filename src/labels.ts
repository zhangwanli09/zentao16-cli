/** 禅道内部代码 → 中文显示名，未收录的原样显示 */

export const BUG_STATUS: Record<string, string> = { active: '激活', resolved: '已解决', closed: '已关闭' };

export const BUG_TYPE: Record<string, string> = {
  codeerror: '代码错误',
  config: '配置相关',
  install: '安装部署',
  security: '安全相关',
  performance: '性能问题',
  standard: '标准规范',
  automation: '测试脚本',
  designdefect: '设计缺陷',
  others: '其他',
};

export const RESOLUTION: Record<string, string> = {
  bydesign: '设计如此',
  duplicate: '重复Bug',
  external: '外部原因',
  fixed: '已解决',
  notrepro: '无法重现',
  postponed: '延期处理',
  willnotfix: '不予解决',
  tostory: '转为需求',
};

/** 默认解决方案代码，用于帮助说明和报错提示 */
export const RESOLUTION_CODES = Object.keys(RESOLUTION).join('、');

export const STORY_STATUS: Record<string, string> = {
  draft: '草稿',
  reviewing: '评审中',
  active: '激活',
  changed: '已变更',
  closed: '已关闭',
};

export const STORY_STAGE: Record<string, string> = {
  wait: '未开始',
  planned: '已计划',
  projected: '已立项',
  developing: '研发中',
  developed: '研发完毕',
  testing: '测试中',
  tested: '测试完毕',
  verified: '已验收',
  released: '已发布',
  closed: '已关闭',
};

export const TASK_STATUS: Record<string, string> = {
  wait: '未开始',
  doing: '进行中',
  done: '已完成',
  pause: '已暂停',
  cancel: '已取消',
  closed: '已关闭',
};

export const TASK_TYPE: Record<string, string> = {
  design: '设计',
  devel: '开发',
  request: '需求',
  test: '测试',
  study: '研究',
  discuss: '讨论',
  ui: '界面',
  affair: '事务',
  misc: '其他',
};

export const ACTION: Record<string, string> = {
  opened: '创建',
  created: '创建',
  edited: '编辑',
  commented: '备注',
  resolved: '解决',
  closed: '关闭',
  activated: '激活',
  assigned: '指派',
  confirmed: '确认',
  bugconfirmed: '确认',
  changed: '变更',
  reviewed: '评审',
  started: '开始',
  finished: '完成',
  paused: '暂停',
  restarted: '继续',
  canceled: '取消',
  recordestimate: '记录工时',
  linked2build: '关联版本',
  linked2plan: '关联计划',
  linked2release: '关联发布',
  tostory: '转需求',
  totask: '转任务',
  frombug: '由Bug转来',
  deleted: '删除',
  undeleted: '还原',
};

export const FIELD: Record<string, string> = {
  title: '标题',
  name: '名称',
  status: '状态',
  stage: '阶段',
  severity: '严重程度',
  pri: '优先级',
  type: '类型',
  module: '模块',
  product: '产品',
  assignedTo: '指派给',
  resolution: '解决方案',
  resolvedBy: '解决者',
  resolvedBuild: '解决版本',
  openedBuild: '影响版本',
  deadline: '截止日期',
  steps: '重现步骤',
  spec: '需求描述',
  verify: '验收标准',
  desc: '描述',
  estimate: '预计工时',
  consumed: '消耗工时',
  left: '剩余工时',
  keywords: '关键词',
  story: '相关需求',
  confirmed: '是否确认',
};

/** 内容很长的富文本字段，历史里只提示"有修改" */
export const LONG_FIELDS = new Set(['steps', 'spec', 'verify', 'desc']);

/** 历史记录中值为账号的字段 */
export const ACCOUNT_FIELDS = new Set(['assignedTo', 'resolvedBy', 'closedBy', 'openedBy', 'finishedBy', 'mailto']);

export const str = (v: unknown): string => (v == null ? '' : String(v)).trim();

export function label(map: Record<string, string>, code: unknown): string {
  const key = str(code);
  return Object.hasOwn(map, key) ? map[key]! : key;
}
