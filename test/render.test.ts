import { describe, expect, it } from 'vitest';
import { fileName, safeExt } from '../src/assets.js';
import { decodeAttr, extractImageSources, htmlToMarkdown, zentaoFileRef } from '../src/render.js';

describe('fileName / safeExt', () => {
  it('拒绝带路径的扩展名，文件名中不出现路径分隔符和 ..', () => {
    expect(safeExt('x/../../.bashrc')).toBeUndefined();
    expect(safeExt('png')).toBe('png');
    const name = fileName('5', '../../evil', 'x/../../../.bashrc');
    expect(name).not.toMatch(/[\\/]|\.\./);
    expect(fileName('55', '截图 1.png', 'png')).toBe('55-截图_1.png');
  });
});

describe('zentaoFileRef', () => {
  it('识别三种图片写法', () => {
    expect(zentaoFileRef('{123.png}')).toEqual({ id: '123', ext: 'png' });
    expect(zentaoFileRef('/zentao/file-read-45.jpg')).toEqual({ id: '45', ext: 'jpg' });
    expect(zentaoFileRef('/index.php?m=file&f=read&t=gif&fileID=9')).toEqual({ id: '9', ext: 'gif' });
    expect(zentaoFileRef('https://example.com/a.png')).toBeUndefined();
  });
});

describe('extractImageSources', () => {
  it('解码 &amp; 并去重', () => {
    const html = '<img src="index.php?m=file&amp;f=read&amp;fileID=1"><img src=\'{2.png}\'><img src="{2.png}">';
    expect(extractImageSources(html)).toEqual(['index.php?m=file&f=read&fileID=1', '{2.png}']);
  });
});

describe('decodeAttr', () => {
  it('解码数字和命名实体，与 getAttribute 结果一致', () => {
    expect(decodeAttr('index.php?m=file&#38;f=read&#x26;fileID=7&amp;t=png')).toBe('index.php?m=file&f=read&fileID=7&t=png');
    expect(decodeAttr('a&unknown;b')).toBe('a&unknown;b');
  });
});

describe('htmlToMarkdown', () => {
  it('src 中的数字实体也能命中本地路径', async () => {
    const html = '<img src="index.php?m=file&#38;f=read&#38;fileID=7">';
    const [src] = extractImageSources(html);
    expect(await htmlToMarkdown(html, new Map([[src, 'local/7.png']]))).toBe('![截图](local/7.png)');
  });

  it('替换图片为本地路径，不转义方括号', async () => {
    const md = await htmlToMarkdown('<p>[步骤]</p><p>1. 打开</p><p><img src="{2.png}"></p>', new Map([['{2.png}', '.zentao/bug-1/2-a.png']]));
    expect(md).toContain('[步骤]');
    expect(md).toContain('![截图](.zentao/bug-1/2-a.png)');
  });

  it('纯文本原样返回', async () => {
    expect(await htmlToMarkdown('第一行\n第二行')).toBe('第一行\n第二行');
  });

  it('空内容返回空串', async () => {
    expect(await htmlToMarkdown(undefined)).toBe('');
    expect(await htmlToMarkdown('  ')).toBe('');
  });
});
