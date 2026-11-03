# dsh-ssh-mac

DeepSeek Harness 的 SSH 插件。主机记录除地址外还存网卡 MAC，建链前先按 MAC 把机器解析成它当前的 IP：查邻居表、多地址时探端口消歧、必要时扫本机网段，全不中才用记录的地址。DHCP 换号、机器换网段、笔记本带出带进，都不改配置。

主机管理、xterm 终端、SFTP 传输、端口转发、集群执行全部保留；本插件只替换建链时的地址来源，并额外提供 MAC 维护与解析诊断。

## 能力

| 能力 | 说明 |
| --- | --- |
| MAC 解析 | 短路链：无 MAC 直连 → 缓存/负缓存 → 邻居表唯一私网地址 → 多地址探 22 端口消歧 → 扫本机网段 → 记录地址兜底。每步命中即止 |
| 记录自维护 | 新增主机时地址若在邻居表里，MAC 当场落库（批量导入只读一次表）；解析到新地址立刻回写 `host`，且早于认证，密码过期也照样跟上 |
| 地址不被误改 | 邻居表 MAC 与记录不一致只告警不改写；公网地址既不取 MAC 也不改写，并跳过扫描（`chx-A100` 由 2.9s 降至 48ms） |
| 密钥优先 | 显式 `authHandler` 改为 `none → publickey → password → keyboard-interactive`；私钥取记录 `keyPath`，否则 `~/.ssh/id_ed25519`、`id_ecdsa`、`id_rsa`、`id_dsa`。带口令而无口令可用时不试，避免 ssh2 解析失败挤掉密码 |
| 诊断工具 | `ssh_mac` 支持 `resolve` / `set` / `clear`；`resolve` 列出配置地址、实际拨号地址、来源、候选、耗时 |
| 面板 | 主机一张卡：别名、`地址:端口`、MAC、用户、认证方式、标签、备注；新增/编辑表单含「网卡 MAC」输入框 |
| 终端并列 | 终端页最多并排 4 个 xterm，每个 pane 各自绑定一条会话。pane 标题右侧 `–` 隐藏窗口（会话继续跑，标签变淡，点回来即 attach，滚动缓冲回放），`×` 真正关闭；某台机器的最后一个窗口关掉后会顺带断开它池化里的 SSH 连接 |
| 剪贴板互通 | 选中即 `Ctrl+Shift+C` 或 `Ctrl+C`（有选区时只复制，不打断进程）复制到本机；`Ctrl+V`、`Ctrl+Shift+V`、`Shift+Insert` 把本机剪贴板写进远端 shell，走 `term.paste` 保留 bracketed paste 框架，多行文本不会提前执行。右键菜单另有复制 / 粘贴 / 全选 / 清屏 |
| Tab 补全 | Tab 原样送给远端，路径与命令补全由远端 bash/zsh/fish 负责；`Shift+Tab` 发 `ESC[Z`。焦点滑到 pane 边框或认证表单时按键会转回终端再发送，不会变成浏览器焦点切换 |
| 手动排序 | 每张卡左侧把手可拖动改顺序，顺序写回 `~/.dsh/dsh-ssh.json`；把手聚焦后按 ↑ / ↓ 也能挪。分组或搜索状态下暂时关闭，避免把局部顺序写成全量 |

`source` 取值：`configured`、`cache`、`neighbor`、`neighbor-probe`、`sweep`、`fallback`。邻居表读取路径：Windows `arp -a`，Linux `ip -4 neigh show`（回退 `/proc/net/arp`），macOS `arp -an`。跳板每一跳与 `ProxyCommand` 走同一套解析。

## 相对 dsh-ssh 的改动

| 改动 | 为什么 | 落在哪 |
| --- | --- | --- |
| 建链前按 MAC 解析地址 | DHCP 换号后记录不会失效，IP 变了照样连得上 | `src/engine/connection-pool.ts` 的 `connectChain` 与新增 `src/mac/` |
| 解析结果与 MAC 回写记录 | 把「人工维护 IP」换成「自己长完整」：新主机当场取 MAC，连上就回写地址 | `src/mac/resolve.ts`、`src/store.ts` |
| 认证顺序改成密钥优先 | ssh2 默认先试密码，密码一废整条链路就连不上 | `buildConnectConfig` 里显式 `authHandler` |
| 终端并列、隐藏与真关闭 | 一台机器常要开多个窗口；关窗要能带走会话，也要能留活口 | `TerminalPane.tsx`、`controller.ts`、`/hosts/disconnect` |
| 剪贴板与 Tab 转发 | Web 终端默认丢 `Ctrl+V`、焦点漂移时丢 Tab | `clipboard.ts`、`TerminalPane.tsx` |
| 主机卡片 + 拖拽排序 | 9 列表格在窄面板里横向溢出，且顺序只能靠删了重加 | `HostsTab.tsx`、`/hosts/reorder` |
| 面板视觉重写 | 原面板是通用表单灰；这套按 RhineLabUI 的语法重做 | `panel.module.css`、`rhine.tsx` |
| 解析并发去重与失败退避 | 多标签同时连一台机只解析一次；解析失败按 30s→10min 退避，不反复扫网段 | `resolve.ts` |

命令行 `ssh` 的那套（`~/.ssh/mac_resolve.py` + `Match … exec` + `~/.ssh/mac-hosts/`）与插件各自独立解析，规则一致：跳过 `0.0.0.0/8`、`127/8`、`169.254/16`、`198.18/15`、`100.64/10`；前缀小于 `/22` 时按 `/24` 扫；多候选先探活再优先私网地址。两边的 MAC 真源都是 `~/.ssh/config` 里那条 `# MacAddress` 注释，插件导入时直接读它。

## 安装

```bash
cd dsh-ssh-mac
npm install && npm run rebuild   # 构建宿主与面板，并同步进 profile
```

新机器上还要两步：

1. 把 `package.json`、`cordis.patch.yml`、`lib/` 放到 `~/.dsh/profiles/desktop/node_modules/dsh-ssh-mac/`，不要带本包 `node_modules`
2. profile 的 `package.json` 里 `dependencies` 与 `dsh.profile.bundles` 都加 `dsh-ssh-mac`；profile 的 `cordis.patch.yml` 把 `- id: ssh` 置 `disabled: true`，并加 `- id: ssh-mac` / `name: dsh-ssh-mac` / `disabled: false`

宿主端只转译不打包（`node:*`、`ssh2`、`ws`、`@deepseek-ai/*` 全 external）；面板由 `scripts/build-client.mjs` 用 esbuild 现场构建，类名带 `sshx_` 前缀，样式经 `style-runtime.ts` 注入。改面板后按一次 Ctrl+R 换新 bundle。

## 配置

profile 的 `ssh-mac` 行 config：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `macFirstEnabled` | `true` | 关掉后完全按配置地址连接 |
| `macResolveTtlMs` | `300000` | 解析结果缓存时长 |
| `macLearn` | `true` | 连上后反查 MAC 写回记录 |
| `macUpdateHost` | `true` | 解析到新地址后写回 `host` |
| `preferKey` | `true` | 有私钥时先公钥后密码 |
| `macSweep` | `true` | 邻居表没有时是否扫网段 |
| `macSweepTimeoutMs` | `6000` | 单次扫描预算 |
| `macProbePort` | `22` | 消歧与刷 ARP 用的端口 |

加 MAC 的三种写法：`ssh_mac action=set`；`~/.ssh/config` 的 Host 块内写 `# MacAddress 20:bd:1d:28:be:d2` 后从面板导入；表单或直接改 `~/.dsh/dsh-ssh.json`。分隔符随意，入库统一成 `aa:bb:cc:dd:ee:ff`。

## 数据与安全

- 主机记录 `~/.dsh/dsh-ssh.json`，版本化 JSON、0600 原子写；密码与私钥口令明文存储，与上游同一信任模型
- 路由 `/api/dsh-ssh/*` 仅回环
- 公网地址不参与 MAC 学习与地址改写

## 已知限制

- 只在邻居表能看到的网段生效：跨网段、VPN 之外的机器没有 ARP 记录，只能靠记录的地址。
- 盲扫有成本：本机网段 `/24` 约 2–6 秒，邻居表命中只要几十毫秒。所以参数化成了 `macSweep`、`macSweepTimeoutMs`。
- 一台机器换过网卡，旧 MAC 会被当作「找不到」而回落地址，不会自己改 MAC。
- 宿主的客户端 bundle 带 `mtime+size` 版本戳，改完前端要 Ctrl+R（或重启 dsh）才会换成新代码；宿主侧靠 patch 文件热重载。
- 命令行 `ssh` 走的是另一套 `~/.ssh/mac_resolve.py`。它的 `Include` 必须写 `~/.ssh/mac-hosts/<别名>`：Windows 绝对路径 `C:/…` 会被 OpenSSH 当成 `~/.ssh` 下的相对路径，静默匹配不到文件，于是永远用配置里那个旧 `HostName`。

- 邻居表只在同一广播域有效；换网段或本机不在该网段时只剩扫本机网段，扫不到即 fallback
- 多地址（虚拟化、桥接、端口镜像）靠 22 端口消歧，探不通退回记录地址
- 记录地址为公网时不扫描，等同于纯地址连接
- 端口扫描为 TCP 连接探测，防火墙丢包时会等到预算耗尽

## 基于 dsh-ssh 二次开发

本插件是 [`@linxin666/dsh-ssh`](https://www.npmjs.com/package/@linxin666/dsh-ssh) 源码的二次开发，两者不能同时启用。

上游的合入点只有两处：`src/engine/connection-pool.ts` 的建链函数，以及新增的 `src/mac/`。当前跟随到上游 0.4.14——该版本相对 0.4.12 没有代码改动，只加了 `locale/{zh,en}.json` 里的插件元数据（`meta.title` / `meta.description`），这部分已按本插件自己的描述重写。
