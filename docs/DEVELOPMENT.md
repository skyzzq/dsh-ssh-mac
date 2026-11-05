# 开发文档

给接手这个仓库的人看的。读完应当知道：代码分几块、请求怎么走、改一个功能要碰哪些文件、怎么验证、哪些坑已经踩过。

## 1. 定位

dsh-ssh-mac 是 [@linxin666/dsh-ssh](https://github.com/linxin666/dsh-ssh) 的二次开发分支。差别集中在一处：建链前先按网卡 MAC 把主机解析成当前地址，再交给 ssh2。其余（存储、路由、工具、终端、传输、隧道、集群）沿用上游实现。

三条硬约束：

- 插件名 `ssh-mac`，包名 `dsh-ssh-mac`，与上游 `ssh` 是两个插件。
- 复用 `~/.dsh/dsh-ssh.json`、`/api/dsh-ssh`、`ssh_*` 工具名，所以 profile 里 `- id: ssh` 必须 `disabled: true`，否则两套插件抢同一份数据、同一批路由和工具名。
- 客户端 bundle 通过 `window.__ModuleLoader__.load({ id })` 自注册，`id` 必须等于包名，否则加载器报 `loaded without registering`。

## 2. 目录

```
src/
  index.ts                330   插件装配：配置、store、engine、routes、tools、系统提示
  engine.ts               160   SshEngine 门面（list/exec/exec-ish/openShell/上传下载/隧道）
  protocol.ts             244   共享类型 + SSH_API 路由表 + 终端 WS 帧
  store.ts                497   HostStore：主机记录的读写、校验、排序、从 ssh_config 导入
  ssh-config.ts           177   ~/.ssh/config 解析（Host 块、Include、注释里的 MAC）
  routes.ts               527   HTTP 路由 + WS 升级
  tools.ts                534   7 个 Agent 工具的定义与渲染
  http.ts / loopback.ts   230   请求体读取、回环校验
  dsh-home.ts / mount-once.ts / tool-surface.ts / telemetry.ts
  engine/
    connection-pool.ts    746   连接池、建链、认证顺序、MAC 注入点
    pty.ts                 75   交互式 shell
    sftp.ts               215   上传下载与目录浏览
    tunnel.ts             185   SSH 端口转发
    cluster.ts             56   批量执行
    terminal-sessions.ts  256   终端会话登记与接管
  mac/                          本插件新增
    resolve.ts            449   解析链、缓存、退避、记录回写
    neighbor.ts           168   IPv4 邻居表（arp / ip neigh / /proc/net/arp）
    neighbor6.ts          162   IPv6 邻居表（PowerShell / ip -6 neigh / ndp）
    net-utils.ts          152   网段、私网判定、扫描计划
    net-format.ts          46   纯字符串：地址识别、`[v6%zone]:port` 格式化
    probe.ts               58   TCP 探活、并发限流
    mac-address.ts         38   归一化与单播校验
  client/                       浏览器半
    index.ts              134   注册 locale、面板、设置项
    api.ts                623   SshApi：所有 HTTP 调用的唯一出口
    panel/SshPanel.tsx     82   面板外壳（品牌标记 + 标签栏）
    panel/controller.ts   528   面板状态机：标签、并列 pane、draftAlias
    panel/HostsTab.tsx    413   主机卡片、拖拽排序、分组
    panel/TerminalTab.tsx 210   标签条与并行容器
    panel/TerminalPane.tsx467   单个终端：xterm、剪贴板、Tab、隐藏/关闭
    panel/HostFormDialog.tsx274 主机表单（含 MAC 字段）
    panel/rhine.tsx        93   RhineLabUI 的品牌标记与调色板常量
    panel/panel.module.css       Rhine 视觉层（类名由构建时加 `sshx_` 前缀）
    locales.ts            398   zh / en 双份文案
```

## 3. 装配

`src/index.ts` 是一个 cordis 插件：

```ts
export const name = 'ssh-mac'
export const inject = ['webServer', 'tools', 'systemPrompt']
export const apply = mountOnce('dsh-ssh-mac', applyImpl)
```

`applyImpl` 里按顺序做四件事：建 `HostStore`（带 2 秒复用的邻居表闭包，用于新增主机时补 MAC）、建 `SshEngine`、`makeRoutes` 拿到 `{ routes, upgrade, terminalSessions }`、把 7 个工具注册进 `tools`。配置项全部 `.volatile()`，改设置即时生效：`sync()` 里对比新旧配置，差异时替换 `engine.opts.mac` 并调 `invalidateMacCache()`。

## 4. 解析链

`resolveMacTarget(mac, configuredHost)` 是唯一入口，`connection-pool.ts` 的 `dial()` 在每个跳板机与目标机上各调一次。

顺序：

1. 宏开关 / MAC 形态校验。空 MAC 直接返回 `configured`。
2. 内存缓存（`ttlMs`，默认 5 分钟）。
3. 负缓存：失败记录带指数退避，`min(negativeTtlMs × 2^(n-1), 10 分钟)`。
4. IPv4 邻居表：MAC 对应恰好一个可用地址即命中，`source = 'neighbor'`。
5. 多候选：按 `probePort`（默认 22）并发 TCP 探活，只有唯一存活者才算数，`source = 'neighbor-probe'`。探活顺带刷新 ARP 表。
6. IPv6 邻居表（不主动发现）：这两台机器在新网段只有链路本地地址时靠这一步，`source = 'neighbor6'`。
7. 扫本机网段：只在地址是局域网地址时进行；`sweepCidrFor` 在真实前缀小于 /22 时收敛到 /24，上限 2048 个地址、并发 128、总超时 `sweepTimeoutMs`（默认 6 秒）。
8. 重读 IPv4 邻居表；再以 `ping ff02::1%接口` 触发 IPv6 邻居发现后重读。
9. 全落空：`fallback` 到记录地址，写负缓存，退避窗口内不再重试。

同一 `mac@configuredHost` 的并发解析会合并成一个 in-flight Promise，避免多个终端同时连同一台机器时重复扫网段。

`usableAddress()` 决定什么算可用：IPv4 必须是私网且不在跳过表（`0/8`、`127/8`、`169.254/16`、`198.18/15`、`100.64/10`）；IPv6 只接受 `fe80::/10`。

`isLocalDialAddress()` 是公网守卫：地址既不是私网 IPv4 也不是链路本地 IPv6 时，跳过扫网段和 IPv6 发现——公网主机上没有「同网段」这回事。

## 5. 记录会自己长完整

- 新增主机若没填 MAC，`HostStore.create()` 调 `seedMac()`，用邻居表反查一次（2 秒缓存的同步表）。
- 建链时解析成功且地址变了，`recordConnectionIdentity()` 写回 `host`；发生在认证之前，所以凭据过期也能跟上新地址。
- 连上之后再调一次，只在记录原本没有 MAC 时补 MAC；已有 MAC 与实测不一致只 `console.warn`，不覆盖——MAC 是人工维护的真值。
- 两条开关：`macUpdateHost`（写回地址）、`macLearn`（补 MAC）。

## 6. 认证顺序

`buildConnectConfig()` 组装 ssh2 配置。ssh2 默认顺序是 password → publickey，所以同时给密码和私钥时会先试密码。要密钥优先必须显式给 `authHandler`：

```
['none', 'publickey', 'password', 'keyboard-interactive']
```

`preferKey`（默认开）时：显式 `keyPath` 存在就用它，否则按 `id_ed25519 → id_ecdsa → id_rsa → id_dsa` 找默认私钥；发现型密钥若是加密的且没有口令，就不提供——否则 ssh2 解析失败会连密码都轮不到。

## 7. 数据模型

```ts
SshHostEntry   // 落盘
  alias, host, port, user, mac?,
  auth: { kind: 'key' | 'password' | 'agent', keyPath?, passphrase?, password?, agentPath? },
  proxyJump: string[], proxyCommand?, description?, environment?,
  tags: string[], location?, forwardAgent?, createdAt, updatedAt

SshHostSummary // 出网（无密钥材料）
  ...同上，另有 keyReady: boolean

MacResolution
  alias, mac?, configuredHost, host, source, resolved,
  candidates: string[], swept: boolean, durationMs, note?
```

`source` 取值：`configured | cache | neighbor | neighbor-probe | neighbor6 | sweep | fallback`。

**注意**：工具结果经 tool bridge 序列化时会拒收 `undefined` 值，可选字段一律条件展开。

## 8. HTTP 与 WS

基址 `/api/dsh-ssh`（`SSH_API_BASE`），路由表在 `protocol.ts:245`：

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/hosts` | GET / POST | 列表、新增 |
| `/hosts/:alias` | PATCH / DELETE | 更新（patch 语义）、删除 |
| `/hosts/reorder` | POST | `{ aliases: string[] }`，未列出的记录按原相对顺序接在尾部 |
| `/hosts/disconnect` | POST | `{ alias: string }`，断开该记录在池中的所有连接 |
| `/hosts/import-ssh-config` | POST | 从 `~/.ssh/config` 导入 |
| `/test` `/exec` `/cluster` | POST | 连通性测试、执行、批量执行 |
| `/upload` `/download` `/ls` | POST | SFTP 三个动作 |
| `/tunnel` | POST | 端口转发管理 |
| `/terminal` | WS 升级 | 交互式终端 |

除 WS 外全部要求请求来自回环地址（`guard()`）。终端帧类型在 `protocol.ts:221`，服务端 `output|ready|exit|auth`，客户端 `input|resize|auth|close`。

## 9. Agent 工具

`ssh_list`、`ssh_exec`、`ssh_upload`、`ssh_download`、`ssh_tunnel`、`ssh_cluster` 沿用上游，另加：

`ssh_mac` — action `resolve | set | clear`。`resolve` 逐个解析并给出判决（地址、来源、耗时、候选、是否扫过网段），`fresh: true` 时先清缓存重解析。加字段要同步改三处：`tools.ts` 的输出 schema（`additionalProperties: false`，加字段必须显式声明）、渲染函数、`locales` 里没有的部分（工具输出不走 locale）。

## 10. 客户端

源码用 esbuild 现场打包，不依赖上游预构建产物：

- `scripts/build-client.mjs` 入口 `src/client/index.ts`，`format: 'cjs'`、`platform: 'browser'`、`jsx: 'automatic'`，外部化 `react` / `react/jsx-runtime`，输出包成 `window.__ModuleLoader__.load({ id: '<包名>', factory })`。
- `.module.css` 由插件转成「推样式 + 导类名映射」：`style-runtime.ts` 的 `pushStyle()` 入队，`apply()` 里 `ctx.effect(() => installStyles())` 一次性注入 `<style>`。
- 类名在构建时统一加 `sshx_` 前缀（`scopeCss`），避免和宿主其它插件冲突。
- **esbuild 的 `onLoad` filter 是 Go 正则，不支持 lookbehind**，`.module.css` 与 `.css` 靠插件内部判断，不要写成 `(?<!\.module)\.css$`。

面板结构：`SshPanel` 外壳 → 5 个标签（主机 / 终端 / 传输 / 隧道 / 集群）。`controller.ts` 是纯状态机，`commit()` 重建快照并广播；终端并列最多 4 个 pane（`MAX_PANES`），每个 pane 独占一个 xterm 和一条会话，`TerminalPane` 自己负责绑定/解绑，`releaseLink()` 决定是接管还是断开。

样式层是 RhineLabUI 的视觉语言：`rhine.tsx` 提供品牌 path 和调色板常量，`panel.module.css` 顶部把 `--rh-*` 变量集挂在 `.panel` / `.modal` 上，暗色走 `prefers-color-scheme`。

## 11. 命令

```bash
npm install                 # 首次
npm run build              # tsdown：宿主侧 → lib/index.js
npm run build:client       # esbuild：客户端 → lib/client.js
npm run build:all          # 两者
npm run sync               # 复制 package.json / cordis.patch.yml / README / locale / lib 到 profile
npm run typecheck          # 两个 tsconfig（host / client）
npm run verify             # 解析链、存储、认证顺序等 26 条断言
npm run verify:panes       # 面板状态机 14 条断言
npm run verify:all
```

`sync-to-profile.mjs` 刻意不复制 `node_modules`：本包的依赖（ssh2、ws、xterm）由 profile 提供，把整套 `@deepseek-ai/*` 一起装进去会出现第二份平台实例。

## 12. 生效方式

- 宿主侧（`lib/index.js`）：改 profile 的 `cordis.patch.yml`（任意注释变更）即触发插件热重载。
- 客户端（`lib/client.js`）：bundle 的版本号是 `metadata` 的哈希（mtime / ctime / size），热重载不换客户端，必须 Ctrl+R 或重启 dsh。

## 13. 发布

```bash
node scripts/prepare-publish.mjs --owner <owner> --repo <repo>   # 生成 release/*.tgz 与市场条目
GH_TOKEN=... node scripts/publish-github.mjs --owner <owner>     # push / release / 提 PR
node scripts/publish-github.mjs --dry-run                        # 只看不改
```

上架规则见 `docs/PUBLISHING.md`。要点：仓库要有 `dsh.bundle`、满 1 天、加 `dsh-plugin` topic；条目 tarball 用 `releases/latest/download/…`，所以发版必须挂同名 asset，否则安装 404；lib 产物入库，push 前先 `npm run build:all`。

## 14. 踩过的坑

- `ops_bash` 在 workspace-write 下起不来（`CreateFileMapping … Win32 error 5`），构建类命令要在完整权限下跑。
- `node --experimental-strip-types` 不支持 TS 参数属性，带构造器参数属性的文件走 esbuild 打包后再跑。
- xterm 的 `attachCustomKeyEventHandler` 返回 `false` 不会取消浏览器默认动作；粘贴必须交还原生 paste 事件，否则贴两遍。
- `.termTabs { overflow-x: auto }` 会裁掉绝对定位的浮层，浮层改用 `position: fixed` + 元素坐标。
- 客户端一旦 import `node:*`，浏览器包直接失败（`TS2307: Cannot find module 'node:os'`）；浏览器会用到的东西放 `net-format.ts`。
- 一次性改写脚本要按 CRLF 处理，`indexOf` 用 `\n` 会在 Windows 换行文件上静默找不到。

## 15. 已知限制

- IPv6 解析拿到的是链路本地地址，带 `%接口号`；换网卡或接口号变化后要等下次解析。
- 邻居表里没有的 MAC，只能靠扫网段发现；跨网段（不同子网）没有 ARP 也没有 IPv6 邻居条目，必然 fallback。
- 扫网段受 `sweepTimeoutMs` 约束，大网段会只扫到一部分，靠负缓存避免每次都付这个代价。
- 面板一次最多 4 个并列终端。
