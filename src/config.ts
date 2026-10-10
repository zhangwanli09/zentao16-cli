import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ExitCode, ZentaoError } from './errors.js';

export interface Config {
  url: string;
  account: string;
  password: string;
  /** 只读模式：拒绝写操作和任意路由请求 */
  readonly?: boolean;
}

/** 产品/模块 ID → 本地代码仓库路径，模块优先于产品 */
export interface RepoMap {
  products?: Record<string, string>;
  modules?: Record<string, string>;
}

export const CONFIG_DIR = process.env.ZENTAO_HOME ?? join(homedir(), '.zentao');

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (e) {
    throw new ZentaoError(`配置文件 ${file} 不是合法 JSON：${(e as Error).message}`);
  }
}

/** 环境变量优先，其次 ~/.zentao/config.json；ZENTAO_READONLY=1 或存在 ~/.zentao/readonly 时为只读模式 */
export function loadConfig(): Config {
  const configFile = join(CONFIG_DIR, 'config.json');
  const file = readJson<Partial<Config>>(configFile) ?? {};
  const config = {
    url: process.env.ZENTAO_URL ?? file.url,
    account: process.env.ZENTAO_ACCOUNT ?? file.account,
    password: process.env.ZENTAO_PASSWORD ?? file.password,
  };
  const missing = Object.entries(config)
    .filter(([, v]) => !v)
    .map(([k]) => `ZENTAO_${k.toUpperCase()}`);
  if (missing.length) {
    throw new ZentaoError(
      `缺少配置：${missing.join('、')}。请设置环境变量，或在 ${configFile} 中填写 url/account/password`,
      ExitCode.Auth,
    );
  }
  const readonly = process.env.ZENTAO_READONLY === '1' || existsSync(join(CONFIG_DIR, 'readonly'));
  return { ...(config as Required<Omit<Config, 'readonly'>>), readonly };
}

export function loadRepoMap(): RepoMap {
  return readJson<RepoMap>(join(CONFIG_DIR, 'repos.json')) ?? {};
}

/** 按模块路径从深到浅查找，找不到再按产品查找 */
export function resolveRepo(map: RepoMap, productId?: string, moduleIds: string[] = []): string | undefined {
  for (const id of [...moduleIds].reverse()) {
    const repo = map.modules?.[id];
    if (repo) return repo;
  }
  return productId ? map.products?.[productId] : undefined;
}
