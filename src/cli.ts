#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Argument, Command, InvalidArgumentError, Option } from 'commander';
import { addComment, assignBug, resolveBug, type ResolveOptions } from './actions.js';
import { ZentaoClient } from './client.js';
import { loadConfig, loadRepoMap } from './config.js';
import { ExitCode, ZentaoError } from './errors.js';
import { listToMarkdown, ticketToMarkdown } from './markdown.js';
import { label, RESOLUTION, RESOLUTION_CODES } from './labels.js';
import { fetchTicket, LIST_LIMIT, listMine, TICKET_TYPES, TYPE_LABEL } from './ticket.js';
import type { TicketType } from './types.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const client = () => new ZentaoClient(loadConfig());

function output(cmd: Command, data: unknown, markdown: () => string): void {
  const json = cmd.optsWithGlobals<{ json?: boolean }>().json;
  process.stdout.write(`${json ? JSON.stringify(data, null, 2) : markdown()}\n`);
}

function parseId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new InvalidArgumentError(`无效的 ID：${value}`);
  return id;
}

/** 禅道的列表代码只由字母、数字、下划线组成 */
function parseCode(value: string): string {
  if (!/^\w+$/.test(value)) throw new InvalidArgumentError(`无效的代码：${value}`);
  return value;
}

const idArgument = () => new Argument('<id>', '单据 ID').argParser(parseId);

/** 备注内容来自 --message 或 --file（- 表示标准输入） */
function readText(opts: { message?: string; file?: string }, required: boolean): string | undefined {
  if (opts.message !== undefined && opts.file) throw new ZentaoError('--message 和 --file 只能二选一');
  if (opts.file) return readFileSync(opts.file === '-' ? 0 : opts.file, 'utf8');
  if (opts.message !== undefined) return opts.message;
  if (required) throw new ZentaoError('请用 --message 或 --file 提供内容');
  return undefined;
}

const program = new Command()
  .name('zentao')
  .description('禅道命令行工具：供开发者与 coding agent 读写禅道单据')
  .version(version)
  .option('--json', '以 JSON 输出');

program
  .command('login')
  .description('验证账号配置并刷新会话')
  .action(async (_opts, cmd: Command) => {
    const user = await client().login();
    output(cmd, user, () => `登录成功：${String(user.realname ?? '')}(${String(user.account ?? '')})`);
  });

program
  .command('my')
  .description('列出指派给我的单据')
  .addOption(new Option('-t, --type <type>', '单据类型').choices(TICKET_TYPES).default('bug'))
  .option('-s, --status <status>', '按状态代码过滤，如 active、doing')
  .action(async (opts: { type: TicketType; status?: string }, cmd: Command) => {
    const { rows, truncated } = await listMine(client(), opts.type, opts.status);
    if (truncated) process.stderr.write(`注意：单据较多，只取了前 ${LIST_LIMIT} 条，结果可能不完整\n`);
    output(cmd, rows, () => listToMarkdown(opts.type, rows));
  });

for (const type of TICKET_TYPES) {
  program
    .command(type)
    .description(`查看${TYPE_LABEL[type]}详情（含历史备注，图片和附件下载到本地）`)
    .addArgument(idArgument())
    .option('--no-download', '不下载图片和附件')
    .option('-o, --out <dir>', '图片和附件的保存目录', '.zentao')
    .action(async (id: number, opts: { download: boolean; out: string }, cmd: Command) => {
      const ticket = await fetchTicket(client(), type, id, { download: opts.download, outDir: opts.out, repos: loadRepoMap() });
      output(cmd, ticket, () => ticketToMarkdown(ticket));
    });
}

program
  .command('comment')
  .description('给单据追加备注（写操作，内容为 Markdown）')
  .addArgument(new Argument('<type>', '单据类型').choices(TICKET_TYPES))
  .addArgument(idArgument())
  .option('-m, --message <text>', '备注内容')
  .option('-f, --file <path>', '从文件读取备注内容，- 表示标准输入')
  .action(async (type: TicketType, id: number, opts: { message?: string; file?: string }, cmd: Command) => {
    const result = await addComment(client(), type, id, readText(opts, true)!);
    output(cmd, result, () => `已添加备注：${result.url}`);
  });

program
  .command('assign')
  .description('指派 Bug，可同时写备注（写操作）')
  .addArgument(idArgument())
  .requiredOption('-u, --user <who>', '指派给谁：账号或姓名')
  .option('-m, --message <text>', '备注（Markdown）')
  .option('-f, --file <path>', '从文件读取备注，- 表示标准输入')
  .action(async (id: number, opts: { user: string; message?: string; file?: string }, cmd: Command) => {
    const result = await assignBug(client(), id, opts.user, readText(opts, false));
    output(cmd, result, () => `Bug #${result.id} 已指派给 ${result.assignedName}(${result.assignedTo})：${result.url}`);
  });

program
  .command('resolve')
  .description('解决 Bug（写操作）')
  .addArgument(idArgument())
  .option('-r, --resolution <code>', `解决方案代码：${RESOLUTION_CODES}`, parseCode, 'fixed')
  .option('-b, --build <build>', '解决版本，trunk 表示主干', 'trunk')
  .option('-a, --assign <account>', '解决后指派给谁（默认提出人）')
  .option('--custom', '解决方案是禅道里自定义的代码（不在默认列表中）')
  .option('--duplicate <bugId>', '重复的 Bug ID（resolution=duplicate 时必填）', parseId)
  .option('-m, --message <text>', '解决说明（Markdown）')
  .option('-f, --file <path>', '从文件读取解决说明，- 表示标准输入')
  .action(
    async (
      id: number,
      opts: Omit<ResolveOptions, 'comment'> & { message?: string; file?: string },
      cmd: Command,
    ) => {
      const result = await resolveBug(client(), id, { ...opts, comment: readText(opts, false) });
      output(cmd, result, () => `Bug #${result.id} 已解决（${label(RESOLUTION, result.resolution)}）：${result.url}`);
    },
  );

program
  .command('raw <module> <method> [params...]')
  .description(
    '调试用：请求任意旧版 JSON 接口并输出原始数据。参数按方法签名顺序写成 key=value（PATH_INFO 模式只看顺序）。禅道部分 GET 请求会改数据，只读模式下会拒绝，请勿加入自动放行',
  )
  .action(async (module: string, method: string, params: string[]) => {
    const args: Array<[string, string]> = params.map((p) => {
      const i = p.indexOf('=');
      if (i <= 0) throw new ZentaoError(`参数格式应为 key=value：${p}`);
      return [p.slice(0, i), p.slice(i + 1)];
    });
    const data = await client().view<unknown>({ m: module, f: method, args }, { unsafe: true });
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  });

program.parseAsync().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`错误：${message}\n`);
  process.exitCode = err instanceof ZentaoError ? err.exitCode : ExitCode.General;
});
