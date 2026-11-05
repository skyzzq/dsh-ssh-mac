# dsh-ssh-mac

DeepSeek Harness 的增强型 SSH 运维插件。专为多设备局域网调试与高效 Agent 协同打造，重点增强了 **网卡 MAC 动态解析**、**多终端列表并行分屏** 与 **可调节独立浮窗**，让你在与 AI 交互协作的同时，享受不中断、不丢配的远程终端体验。

---

### 🌟 核心特性（插件市场概览）

- 🏷️ **MAC 动态寻址（告别静态 IP）**
  建链前优先按机器网卡 MAC 探测解析其实际可用的当前 IP（ARP / 端口探活 / IPv6 邻居发现 / 局域网扫描）。设备 DHCP 换号、笔记本切换网段、多网卡切换均**无需修改配置**；新主机自动学习补齐 MAC，成功建链后智能回写最新 IP。

- 📑 **多列表管理与多终端并行分屏**
  终端页支持多主机、多会话标签列表，**最多可同时并排展示 4 个 xterm 终端窗口**。支持 `–` 隐藏窗口（会话在后台持久运行、滚动缓冲随时回放）与 `×` 彻底关闭；会话宿主接管机制，切换页面连接不中断。

- 🪟 **自由调节独立浮窗（边聊边操作）**
  SSH 整个面板可随时一键弹出为独立悬浮窗。
  - **自由缩放**：支持 8 个方向及右下角手柄自由拖拽调节大小，窗口位置与尺寸自动记忆。
  - **常浮 / 随点下沉**：默认常浮于 DSH 应用上方；支持一键切换为「不常浮」——点击 DSH 聊天主界面浮窗自动下沉隐藏，点击左侧栏 SSH 图标即刻唤出。
  - **跟随宿主**：宿主 DOM 级集成，完全跟随 DSH 窗口最小化（缩小）与关闭，无任何孤儿桌面窗口。

---

## 📝 更新说明 (Changelog)

### v1.6.0 (2026-11)
- **[新增] 整个 SSH 面板独立浮窗功能**：
  - 面板右上角新增「浮窗」按钮，一键脱离主视图进入悬浮模式，中央区域交还给对话界面；
  - 8 向边缘拖拽与右下角网格拖动手柄，支持自适应视口与最小安全尺寸保护；
  - 联动 `ResizeObserver` 与 xterm fitAddon，窗口缩放时实时重算终端行列数并同步给远程 PTY；
  - 提供「常浮」模式（始终置顶）与「不常浮」模式（点击 DSH 主界面自动沉底隐藏，点击左侧 SSH 栏立即唤出）；
  - 浮窗包含完整功能：主机卡片、多终端分屏、SFTP 文件传输、隧道转发及集群批量执行。
- **[优化] 多终端列表与并排展示体验**：
  - 优化多 Tab 列表在窄窗口与浮窗下的布局与自适应能力；
  - 完善后台会话挂起接管逻辑，避免页面切换丢失输出。
- **[增强] MAC 寻址解析稳定性**：
  - 优化局域网 IPv4 ARP / IPv6 链路本地地址探测与并发合并；
  - 增加指数退避负缓存，防止网络不可达时频繁扫网。

---

## 🛠️ 能力一览

| 能力 | 说明 |
| --- | --- |
| **MAC 动态解析** | 短路解析链：无 MAC 直连 → 内存/负缓存 → ARP 唯一可用私网地址 → 多地址探 22 端口消歧 → IPv6 邻居表 → 扫本机网段 → ping `ff02::1` 再查 IPv6 邻居表 → 记录地址兜底。每步命中即止 |
| **记录自维护** | 新增主机若地址在邻居表内，MAC 当场落库；建链解析出新地址立刻回写 `host` 且早于认证，密码过期也能自动跟上最新 IP |
| **多终端并行** | 终端页支持多标签列表与最多 4 个 xterm 并列排布。每个 Pane 独立绑定远程会话，`–` 隐藏后台常驻，`×` 彻底关闭并按需回收连接池连接 |
| **独立弹性浮窗** | 5 大标签功能（主机/终端/传输/隧道/集群）全量支持浮窗化，8 向自由调节宽高，置顶模式与点击主界面下沉隐藏模式自由切换，跟随 DSH 缩小关闭 |
| **剪贴板与快捷键** | 选中文本自动支持 `Ctrl+C` / `Ctrl+Shift+C` 复制本机；`Ctrl+V` / `Ctrl+Shift+V` / `Shift+Insert` 保留 bracketed paste 进远端 shell；Tab / Shift+Tab 完整转发给远端 bash/zsh 负责补全 |
| **密钥优先认证** | 认证链优化为 `none → publickey → password → keyboard-interactive`；优先寻找记录 `keyPath` 或 `~/.ssh/id_*` 默认密钥，杜绝密码失效卡死连接 |
| **IPv6 链路本地支持** | 支持纯 IPv6 或无 IPv4 租约局域网，按 MAC 解析为 `fe80::…%<接口号>` 直接建链 |
| **诊断与维护工具** | 提供 `ssh_mac` Agent 工具（支持 `resolve` / `set` / `clear`），清晰展示解析来源、候选地址与探活耗时 |
| **卡片式拖拽排序** | 主机列表采用 RhineLab 风格卡片视图，拖拽手柄自由排序并持久化至 `dsh-ssh.json` |

---

## 🔄 相对官方 @linxin666/dsh-ssh 的改动

| 改动 | 为什么 | 落在哪 |
| --- | --- | --- |
| **全面板独立浮窗** | 边与 AI 对话边看命令输出，无需在会话与运维面板间反复来回切换 | `SshFloatingWindow.tsx`、`native-panel.tsx`、`panel.module.css` |
| **多终端列表与并列分屏** | 一台机器常需并列查看多个实时日志或操作窗口；需支持优雅隐藏与关闭 | `TerminalTab.tsx`、`TerminalPane.tsx`、`controller.ts` |
| **建链前按 MAC 解析地址** | DHCP 动态分配或主机换网段后记录不失效，IP 变了照样连得上 | `src/engine/connection-pool.ts` 与 `src/mac/` |
| **记录自维护与地址回写** | 变人工维护 IP 为自动学习：连上即补全 MAC 并回写新地址 | `src/mac/resolve.ts`、`src/store.ts` |
| **密钥优先认证** | 上游默认先试密码，密码过期或改动会导致整条链路无法进入密钥阶段 | `connection-pool.ts` 的 `buildConnectConfig` |
| **剪贴板与 Tab 补全修复** | Web 终端默认丢弃粘贴或与浏览器快捷键冲突，焦点漂移时 Tab 丢失 | `clipboard.ts`、`TerminalPane.tsx` |
| **主机卡片与拖拽排序** | 原始表格在窄屏下横向溢出，卡片式更加适合窄栏与浮窗视图 | `HostsTab.tsx`、`/hosts/reorder` |

---

## 📦 安装与生效

### 本地编译构建

```bash
cd dsh-ssh-mac
npm install
npm run build:all   # 同时编译宿主侧与客户端 bundle
npm run sync        # 同步产物至 DSH desktop profile
```

### Profile 注册

确认 profile 的 `package.json` 与 `cordis.patch.yml` 中：
- `dependencies` 与 `dsh.profile.bundles` 包含 `dsh-ssh-mac`；
- 原版 `- id: ssh` 置为 `disabled: true`；
- 本插件 `- id: ssh-mac` / `name: dsh-ssh-mac` 置为 `disabled: false`。

> 💡 **生效方式**：修改客户端代码后，在 DSH 窗口中按下 **Ctrl + R** 刷新即可加载最新客户端 bundle。

---

## ⚙️ 配置项

可在 profile 的 `ssh-mac` 插件配置中调整：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `macFirstEnabled` | `true` | 是否启用 MAC 优先寻址（关闭则直连配置 IP） |
| `macResolveTtlMs` | `300000` | MAC 解析成功缓存时长（毫秒，默认 5 分钟） |
| `macLearn` | `true` | 连上主机后是否自动反查 MAC 补全记录 |
| `macUpdateHost` | `true` | 解析到新地址后是否自动写回主机记录 |
| `preferKey` | `true` | 是否优先尝试私钥认证 |
| `macSweep` | `true` | 邻居表中缺失时是否扫描本地子网 |
| `macSweepTimeoutMs` | `6000` | 单次网段扫描超时时间（毫秒） |
| `macProbePort` | `22` | TCP 探活消歧端口（默认 22） |

---

## 🛡️ 数据与安全

- **数据存储**：主机配置保存在 `~/.dsh/dsh-ssh.json`（0600 原子写入，版本化 JSON 格式）。
- **回环保护**：所有内部 API（`/api/dsh-ssh/*`）均严格限定本地回环地址访问。
- **公网安全**：公网 IP 主机不参与网段扫描、不反查 MAC、不自动改写地址。

---

## 🔗 参考与二次开发

本插件基于 [`@linxin666/dsh-ssh`](https://www.npmjs.com/package/@linxin666/dsh-ssh) 进行二次开发。代码结构、架构设计及自动化测试见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。
