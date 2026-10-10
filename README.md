# zentao-cli

这个命令行工具让开发者和 coding agent（如 Claude Code）直接读写禅道单据。适用于所有自行部署的禅道开源版 16.x：不依赖特定服务器或部署方式，只需要一个能登录网页版的禅道账号。

- 读单据：Bug、需求、任务的详情会输出成 Markdown，包含历史备注和关联信息。正文和备注里的截图、附件会下载到本地，Markdown 中引用的就是这些本地文件，agent 可以直接读图。
- 写单据：可以追加备注、解决 Bug。提交后工具会回读禅道，确认确实写进去了。
- 认证方式：使用网页会话，即旧版 JSON 接口 `index.php?m=...&f=...&t=json`。会话缓存在 `~/.zentao/`，失效时自动重新登录。

## 安装

```bash
npm install -g @zhangwanli/zentao-cli
```

需要 Node.js 20 及以上。安装后提供 `zentao` 命令。禅道官方的 npm 包 `zentao-cli` 也提供同名命令，两者不要同时全局安装，否则会互相覆盖。

## 配置

推荐用环境变量配置（也可以写在 `~/.zentao/config.json` 中，字段为 `url`、`account`、`password`）：

| 变量 | 说明 |
|---|---|
| `ZENTAO_URL` | 禅道地址，填 `index.php` 所在的目录，如 `http://pm.example.com/zentao/`。如果服务器没开 URL 重写，页面地址形如 `.../zentao/index.php/my.html`，则填到 `index.php` 为止，如 `http://pm.example.com/zentao/index.php` |
| `ZENTAO_ACCOUNT` | 账号（建议使用专用账号，只分配需要的权限） |
| `ZENTAO_PASSWORD` | 密码 |
| `ZENTAO_HOME` | 可选，配置和会话缓存目录，默认 `~/.zentao` |

如需把单据对应到本地代码仓库，可在 `~/.zentao/repos.json` 中配置。查找时先按模块匹配（从最深一级往上找），找不到再按产品匹配：

```json
{
  "products": { "3": "D:/projects/member-center" },
  "modules": { "12": "D:/projects/member-center/packages/auth" }
}
```

## 用法

```bash
zentao login                         # 验证配置
zentao my -t bug -s active           # 指派给我的激活 Bug
zentao bug 101                       # Bug 详情（Markdown），图片下载到 .zentao/bug-101/
zentao story 45 --no-download        # 需求详情，不下载附件
zentao task 88 --json                # 任何命令都可以加 --json 输出结构化数据

zentao comment bug 101 -f note.md    # 追加备注（Markdown，自动转为富文本）
zentao assign 101 -u dev1 -f note.md # 指派 Bug 并写备注（-u 填账号或姓名）
zentao resolve 101 -r fixed -b trunk -m "修复验证码缓存问题，见 commit abc123"

zentao raw bug view bugID=101        # 调试：查看原始 JSON
```

退出码：`0` 成功，`1` 一般错误，`2` 单据不存在，`3` 认证、权限或配置问题。

只读模式：设置环境变量 `ZENTAO_READONLY=1`，或创建空文件 `~/.zentao/readonly`，之后 `comment`、`assign`、`resolve` 和 `raw` 会直接拒绝执行（`raw` 能发任意 GET 请求，禅道有些 GET 会改数据）。适合评测、演示，或只想让 agent 读单子的场景。

### 兼容性说明

以下行为在 16.5 上实测过，其余 16.x 版本的旧版 JSON 接口与之相同。

- 自动识别禅道的 URL 模式：PATH_INFO（`bug-view-123.json`）或 GET（`index.php?m=bug&f=view&bugID=123`），识别结果和会话一起缓存。
- 禅道会丢弃没有 Referer 的 POST 请求（防 CSRF），所以工具的所有 POST 都会带上 Referer/Origin。
- 部分页面会在 JSON 后面追加 `<script>`，工具只解析开头那个完整的 JSON 对象。
- 会话失效时，禅道可能跳转到登录页，也可能跳转到 `product-showErrorNone`，两种情况都会自动重新登录。
- 无权限时禅道返回 HTTP 200 和跳转到 `user-deny-<模块>-<方法>` 的脚本，工具会报权限错误（退出码 3）。没有单据所属迭代、项目的权限时，禅道不跳转，而是返回"您无权访问该迭代！"之类的提示，同样报退出码 3。
- 账号没有"添加备注"（action-comment）权限时，`comment` 会被拒绝；可以改用 `assign` 在指派的同时写备注。
- 各家在禅道"自定义"里改过的列表（Bug 类型、解决方案等）都可以用：显示时不认识的代码原样输出，`resolve -r` 用自定义的解决方案代码时要加 `--custom`。禅道不校验这个值，拼错了会被原样存下，所以默认只放行禅道自带的代码。
- 自定义了必填字段的（例如解决 Bug 时必须写备注），缺了字段禅道会拒绝提交，工具会原样报出禅道的提示。

### 部署环境相关

- HTTPS 用的是自签名证书或内部 CA 时，设置 `NODE_EXTRA_CA_CERTS=<CA 证书路径>`，不建议直接关闭证书校验。
- 需要经代理访问禅道时，注意 Node 默认不读取 `HTTP_PROXY`/`HTTPS_PROXY`；Node 版本支持的话，设置 `NODE_USE_ENV_PROXY=1` 即可。
- 登录用的是网页版的账号密码表单。如果登录额外加了验证（验证码、单点登录、二次认证等插件），命令行会登录失败，需要请管理员为工具开一个不走这些验证的账号。

下载目录 `.zentao/` 中会自动生成 `.gitignore`，下载的文件不会被提交到代码库。

## 在 Claude Code 中放行只读命令

在 `settings.json` 的 `permissions.allow` 中加入以下规则：

```json
["Bash(zentao my:*)", "Bash(zentao bug:*)", "Bash(zentao story:*)", "Bash(zentao task:*)"]
```

`comment`、`assign`、`resolve`、`raw` 不要加入放行列表。前三个是写操作；`raw` 能请求任意接口，而禅道有些 GET 请求会修改数据。

## 开发

```bash
pnpm install
pnpm build
pnpm link --global # 用本地源码构建的 zentao 命令
pnpm dev bug 101   # 用 tsx 直接运行源码
pnpm test          # vitest
pnpm typecheck
```

测试数据 `test/fixtures/bug-view.json` 是按禅道 16.x 返回格式手工构造的。接入真实环境后，建议用脱敏后的真实返回替换。
