import type TurndownService from 'turndown';

const NBSP = String.fromCharCode(0xa0);

/** 禅道富文本里引用附件图片的几种写法 */
export function zentaoFileRef(src: string): { id: string; ext?: string } | undefined {
  // 数据库原始写法：{123.png}
  let m = /^\{(\d+)(?:\.(\w+))?\}$/.exec(src);
  if (m) return { id: m[1], ext: m[2] };
  // PATH_INFO 写法：/file-read-123.png
  m = /file-read-(\d+)(?:\.(\w+))?/.exec(src);
  if (m) return { id: m[1], ext: m[2] };
  // GET 写法：index.php?m=file&f=read&t=png&fileID=123
  m = /[?&]fileID=(\d+)/.exec(src);
  if (m) return { id: m[1], ext: /[?&]t=(\w+)/.exec(src)?.[1] };
  return undefined;
}

/** 与 DOM getAttribute 的解码结果保持一致，否则 imageMap 查不到 */
export function decodeAttr(value: string): string {
  const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: NBSP };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return named[code.toLowerCase()] ?? whole;
  });
}

export function extractImageSources(html: string): string[] {
  const srcs = [...html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1/gi)].map((m) => decodeAttr(m[2]));
  return [...new Set(srcs)];
}

/** 当前这次转换的图片映射；turndown 是同步的，所以共享一个实例是安全的 */
let currentImageMap = new Map<string, string>();

let td: TurndownService | undefined;

/** 按需加载 turndown，不读单据的命令不必付出它的启动开销 */
async function getTurndown(): Promise<TurndownService> {
  if (td) return td;
  const { default: Turndown } = await import('turndown');
  const service = new Turndown({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  });
  // 不转义 [步骤] 这类禅道模板里常见的方括号，读起来更干净
  service.escape = (text: string) => text;
  service.remove(['script', 'style']);
  service.addRule('zentaoImage', {
    filter: 'img',
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const src = el.getAttribute('src') ?? '';
      const target = currentImageMap.get(src) ?? src;
      if (!target) return '';
      const alt = el.getAttribute('alt') || el.getAttribute('title') || '截图';
      return `![${alt}](${/\s/.test(target) ? `<${target}>` : target})`;
    },
  });
  return (td = service);
}

/** 禅道富文本 → Markdown，imageMap 把图片原始 src 替换成本地路径 */
export async function htmlToMarkdown(html: string | undefined, imageMap: Map<string, string> = new Map()): Promise<string> {
  if (!html?.trim()) return '';
  if (!/<[a-z][\s\S]*?>/i.test(html)) return html.trim();

  const service = await getTurndown();
  // 从这里到 finally 都是同步执行，不会和其他转换交错
  currentImageMap = imageMap;
  try {
    return service
      .turndown(html)
      .split(NBSP)
      .join(' ')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } finally {
    currentImageMap = new Map();
  }
}
