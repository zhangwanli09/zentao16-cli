import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Downloader, Route } from './client.js';
import { extractImageSources, htmlToMarkdown, zentaoFileRef } from './render.js';
import type { Attachment, RawFile } from './types.js';

/** 超过该大小的附件只列出不下载 */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function toPosixRelative(abs: string): string {
  return relative(process.cwd(), abs).split(sep).join('/');
}

/** 扩展名来自禅道数据，只接受字母数字，防止拼出 ../ 之类的路径 */
export function safeExt(ext?: string): string | undefined {
  return ext && /^[A-Za-z0-9]{1,10}$/.test(ext) ? ext : undefined;
}

export function fileName(id: string, title?: string, rawExt?: string): string {
  const ext = safeExt(rawExt);
  const safe = (title ?? '').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/\.{2,}/g, '.').replace(/^[_.]+|_+$/g, '');
  const base = safe || 'file';
  const withExt = ext && !base.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? `${base}.${ext}` : base;
  return `${id.replace(/\D/g, '')}-${withExt}`;
}

/** 负责把一张单据里的图片和附件下载到本地，并把富文本转成引用本地路径的 Markdown */
export class AssetStore {
  readonly warnings: string[] = [];
  private readonly saved = new Map<string, string>();
  private inlineCount = 0;
  private dirReady = false;

  constructor(
    private readonly client: Downloader,
    private readonly dir: string,
    private readonly files: Map<string, RawFile>,
    private readonly enabled: boolean,
  ) {}

  async markdown(html?: string): Promise<string> {
    if (!html) return '';
    const map = new Map<string, string>();
    for (const src of extractImageSources(html)) {
      const local = await this.image(src);
      if (local) map.set(src, local);
    }
    return htmlToMarkdown(html, map);
  }

  async attachments(): Promise<Attachment[]> {
    const result: Attachment[] = [];
    for (const [id, file] of this.files) {
      const size = file.size === undefined ? undefined : Number(file.size);
      const item: Attachment = { id, title: file.title ?? id, size };
      if (!this.enabled) {
        item.note = '未下载（--no-download）';
      } else if (size !== undefined && size > MAX_ATTACHMENT_BYTES) {
        item.note = '文件过大，未下载';
      } else {
        item.path = await this.fetch(
          id,
          { m: 'file', f: 'download', args: [['fileID', id], ['mouse', 'left']] },
          fileName(id, file.title, file.extension),
        );
      }
      result.push(item);
    }
    return result;
  }

  private async image(src: string): Promise<string | undefined> {
    if (!this.enabled) return undefined;
    if (src.startsWith('data:')) return this.saveDataUri(src);
    const ref = zentaoFileRef(src);
    if (!ref) return undefined;
    const file = this.files.get(ref.id);
    const ext = safeExt(ref.ext) ?? safeExt(file?.extension) ?? 'png';
    return this.fetch(ref.id, { m: 'file', f: 'read', args: [['fileID', ref.id]], t: ext }, fileName(ref.id, file?.title, ext));
  }

  private async fetch(id: string, route: Route, name: string): Promise<string | undefined> {
    const cached = this.saved.get(id);
    if (cached) return cached;
    const dest = resolve(this.dir, name);
    if (relative(resolve(this.dir), dest).startsWith('..')) {
      this.warnings.push(`文件 #${id} 的文件名不安全（${name}），已跳过`);
      return undefined;
    }
    try {
      this.prepareDir();
      await this.client.download(route, dest);
    } catch (e) {
      this.warnings.push(`文件 #${id}（${name}）下载失败：${(e as Error).message}`);
      return undefined;
    }
    const path = toPosixRelative(dest);
    this.saved.set(id, path);
    return path;
  }

  /** 第一次真正写文件时才建目录，并让下载根目录（如 .zentao/）不进版本库 */
  private prepareDir(): void {
    if (this.dirReady) return;
    mkdirSync(this.dir, { recursive: true });
    const ignore = join(dirname(this.dir), '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
    this.dirReady = true;
  }

  private saveDataUri(src: string): string | undefined {
    const m = /^data:image\/([\w.+-]+);base64,(.+)$/s.exec(src);
    if (!m) return undefined;
    const ext = { jpeg: 'jpg', 'svg+xml': 'svg' }[m[1]] ?? safeExt(m[1]) ?? 'img';
    this.prepareDir();
    const dest = resolve(join(this.dir, `inline-${++this.inlineCount}.${ext}`));
    writeFileSync(dest, Buffer.from(m[2], 'base64'));
    return toPosixRelative(dest);
  }
}
