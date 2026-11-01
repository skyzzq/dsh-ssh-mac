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

`source` 取值：`configured`、`cache`、`neighbor`、`neighbor-probe`、`sweep`、`fallback`。邻居表读取路径：Windows `arp -a`，Linux `ip -4 neigh show`（回退 `/proc/net/arp`），macOS `arp -an`。跳板每一跳与 `ProxyCommand` 走同一套解析。

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

- 邻居表只在同一广播域有效；换网段或本机不在该网段时只剩扫本机网段，扫不到即 fallback
- 多地址（虚拟化、桥接、端口镜像）靠 22 端口消歧，探不通退回记录地址
- 记录地址为公网时不扫描，等同于纯地址连接
- 端口扫描为 TCP 连接探测，防火墙丢包时会等到预算耗尽

## 基于 dsh-ssh 二次开发

本插件是 [`@linxin666/dsh-ssh`](https://www.npmjs.com/package/@linxin666/dsh-ssh) 源码的二次开发，两者不能同时启用。
