# zentao16-cli

[![npm](https://img.shields.io/npm/v/zentao16-cli)](https://www.npmjs.com/package/zentao16-cli) [![node](https://img.shields.io/node/v/zentao16-cli)](https://nodejs.org/) [![license](https://img.shields.io/npm/l/zentao16-cli)](./LICENSE)

让开发者和 coding agent 在命令行里读写禅道单据。适用于自行部署的禅道开源版 16.x，只需要一个能登录网页版的账号。

- **读**：Bug、需求、任务详情输出为 Markdown，含历史备注；截图、附件下载到本地，agent 可以直接看图。
- **写**：追加备注、指派、解决 Bug，提交后回读确认。

## 安装

```bash
npm install -g zentao16-cli
```

需要 Node.js 22.12+。禅道官方的 `zentao-cli` 也提供 `zentao` 命令，不要同时全局安装。

## 配置

设置环境变量，或写在 `~/.zentao/config.json`（字段 `url`、`account`、`password`），环境变量优先：

| 变量 | 说明 |
|---|---|
| `ZENTAO_URL` | `index.php` 所在目录，如 `http://pm.example.com/zentao/`；页面地址形如 `.../index.php/my.html` 时填到 `index.php` 为止 |
| `ZENTAO_ACCOUNT` | 账号，建议用专用账号 |
| `ZENTAO_PASSWORD` | 密码 |
| `ZENTAO_HOME` | 可选，配置和会话缓存目录，默认 `~/.zentao` |
| `ZENTAO_READONLY` | 可选，`1` 开启只读模式 |

**只读模式**：设 `ZENTAO_READONLY=1` 或创建空文件 `~/.zentao/readonly`，`comment`、`assign`、`resolve`、`raw` 都会被拒绝。

**仓库映射**：在 `~/.zentao/repos.json` 配置后，单据详情会多一行“对应仓库”，告诉 agent 去哪个目录改代码。模块优先于产品：

```json
{
  "products": { "3": "D:/projects/member-center" },
  "modules": { "12": "D:/projects/member-center/packages/auth" }
}
```

## 用法

```bash
zentao login                         # 验证配置
zentao my -t bug -s active           # 指派给我的单据（-t bug|story|task）
zentao bug 101                       # 详情，附件下载到 ./.zentao/bug-101/
zentao story 45 --no-download        # 不下载附件
zentao task 88 --json                # 任何命令都可以加 --json

zentao comment bug 101 -f note.md    # 追加备注（-m 文本 / -f 文件 / -f - 标准输入）
zentao assign 101 -u dev1 -m "请复测"  # 指派 Bug 并写备注
zentao resolve 101 -r fixed -m "修复验证码缓存问题"
zentao resolve 102 -r duplicate --duplicate 101

zentao raw bug view bugID=101        # 调试：查看原始 JSON
```

完整参数见 `zentao <命令> --help`。退出码：`0` 成功，`1` 一般错误，`2` 单据不存在，`3` 认证、权限或配置问题。

## Agent Skill

配套的 [Agent Skill](./skills/zentao/SKILL.md) 让 coding agent 按“读单子 → 梳理 → 澄清/开发 → 回写”的流程处理禅道单据：

```bash
npx skills add zhangwanli09/zentao16-cli
```

## 兼容性与部署

在 16.5 上实测，其余 16.x 的旧版 JSON 接口相同。会话失效自动重登，URL 模式（PATH_INFO / GET）自动识别。

- 无权限时报退出码 3。账号没有“添加备注”权限时 `comment` 会失败，可改用 `assign` 写备注。
- 禅道里自定义的解决方案代码需加 `--custom`（禅道不校验，拼错会原样存下）。
- 自签名证书设 `NODE_EXTRA_CA_CERTS=<CA 证书路径>`；走代理设 `NODE_USE_ENV_PROXY=1`。
- 登录有验证码、单点登录、二次认证时无法使用，需要管理员开一个不走这些验证的账号。

## 开发

```bash
pnpm install
pnpm build
pnpm dev bug 101   # 直接运行源码
pnpm test
pnpm typecheck
```

欢迎提 [Issue](https://github.com/zhangwanli09/zentao16-cli/issues) 和 PR，提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)。

## 许可证

[MIT](./LICENSE)
