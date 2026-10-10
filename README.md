# zentao-cli

[![npm](https://img.shields.io/npm/v/@zhangwanli/zentao-cli)](https://www.npmjs.com/package/@zhangwanli/zentao-cli) [![node](https://img.shields.io/node/v/@zhangwanli/zentao-cli)](https://nodejs.org/) [![license](https://img.shields.io/npm/l/@zhangwanli/zentao-cli)](./LICENSE)

让开发者和 coding agent 直接读写禅道单据的命令行工具。适用于自行部署的禅道开源版 16.x，只需要一个能登录网页版的账号。

- **读**：Bug、需求、任务详情输出为 Markdown，含历史备注和关联信息；截图、附件下载到本地，agent 可以直接读图。
- **写**：追加备注、指派、解决 Bug，提交后回读确认。
- **认证**：用网页版账号密码登录，调用旧版 JSON 接口（`index.php?m=...&f=...&t=json`）。会话缓存在 `~/.zentao/`，失效自动重登。

## 安装

```bash
npm install -g @zhangwanli/zentao-cli
```

需要 Node.js 22.12+。禅道官方的 `zentao-cli` 包也提供 `zentao` 命令，不要同时全局安装。

## 配置

用环境变量，或写在 `~/.zentao/config.json`（字段 `url`、`account`、`password`）：

| 变量 | 说明 |
|---|---|
| `ZENTAO_URL` | `index.php` 所在目录，如 `http://pm.example.com/zentao/`；未开 URL 重写（页面形如 `.../index.php/my.html`）则填到 `index.php` 为止 |
| `ZENTAO_ACCOUNT` | 账号（建议专用账号，最小权限） |
| `ZENTAO_PASSWORD` | 密码 |
| `ZENTAO_HOME` | 可选，配置和缓存目录，默认 `~/.zentao` |
| `ZENTAO_READONLY` | 可选，`1` 开启只读模式 |

**只读模式**：设 `ZENTAO_READONLY=1` 或创建空文件 `~/.zentao/readonly`，`comment`、`assign`、`resolve`、`raw` 都会被拒绝（禅道部分 GET 请求会改数据，所以 `raw` 也算写）。

**仓库映射**：在 `~/.zentao/repos.json` 配置后，单据详情会多一行"对应仓库"，告诉 agent 去哪个目录改代码。先按模块（从最深一级往上）匹配，再按产品匹配：

```json
{
  "products": { "3": "D:/projects/member-center" },
  "modules": { "12": "D:/projects/member-center/packages/auth" }
}
```

## 用法

```bash
zentao login                         # 验证配置
zentao my -t bug -s active           # 指派给我的激活 Bug（-t bug|story|task，最多 200 条）
zentao bug 101                       # Bug 详情，图片下载到 .zentao/bug-101/
zentao bug 101 -o tmp/zentao         # 指定下载目录
zentao story 45 --no-download        # 需求详情，不下载附件
zentao task 88 --json                # 任何命令都可以加 --json

zentao comment bug 101 -f note.md    # 追加备注（-m 文本 / -f 文件 / -f - 标准输入，Markdown 自动转富文本）
zentao assign 101 -u dev1 -f note.md # 指派 Bug 并写备注（-u 账号或姓名）
zentao resolve 101 -r fixed -b trunk -m "修复验证码缓存问题，见 commit abc123"
zentao resolve 102 -r duplicate --duplicate 101

zentao raw bug view bugID=101        # 调试：查看原始 JSON
```

- `resolve` 还支持 `-a` 解决后指派、`--custom` 使用自定义解决方案代码；完整参数见 `zentao <命令> --help`。
- 下载目录会自动生成 `.gitignore`。
- 退出码：`0` 成功，`1` 一般错误，`2` 单据不存在，`3` 认证、权限或配置问题。

## 兼容性

在 16.5 上实测，其余 16.x 的旧版 JSON 接口相同。

- 自动识别 PATH_INFO（`bug-view-123.json`）或 GET（`index.php?m=bug&f=view&bugID=123`）URL 模式，结果随会话缓存。
- 禅道会丢弃没有 Referer 的 POST（防 CSRF），工具的 POST 都带 Referer/Origin。
- 部分页面在 JSON 后追加 `<script>`，工具只解析开头完整的 JSON 对象。
- 会话失效时跳转到登录页或 `product-showErrorNone`，都会自动重登。
- 无权限时禅道返回 HTTP 200 并跳转 `user-deny-<模块>-<方法>`；无迭代、项目权限时返回"您无权访问该迭代！"等提示。两种都报退出码 3。
- 账号没有"添加备注"（action-comment）权限时 `comment` 会失败，可改用 `assign` 在指派时写备注。
- 支持禅道"自定义"过的列表：不认识的代码原样显示；`resolve -r` 用自定义代码需加 `--custom`（禅道不校验该值，拼错会原样存下）。
- 自定义必填字段缺失时，原样报出禅道的提示。

## 部署环境

- 自签名证书或内部 CA：设 `NODE_EXTRA_CA_CERTS=<CA 证书路径>`，不建议关闭证书校验。
- 代理：Node 默认不读 `HTTP_PROXY`/`HTTPS_PROXY`，支持的版本可设 `NODE_USE_ENV_PROXY=1`。
- 登录加了验证码、单点登录、二次认证等插件时命令行无法登录，需要管理员开一个不走这些验证的账号。

## 开发

```bash
pnpm install
pnpm build
pnpm link --global # 全局使用本地构建
pnpm dev bug 101   # tsx 直接运行源码
pnpm test
pnpm typecheck
```

欢迎提 [Issue](https://github.com/zhangwanli09/zentao-cli/issues) 和 PR，提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)。

## 许可证

[MIT](./LICENSE)
