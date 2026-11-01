/**
 * dsh-ssh — host half. Mounts the SSH engine (persistent ssh2 connection
 * pool, exec / PTY shell / SFTP / tunnels / cluster), the /api/dsh-ssh route
 * family plus the terminal WebSocket upgrade, the agent tools (ssh_list,
 * ssh_exec, ssh_upload, ssh_download, ssh_tunnel, ssh_cluster), and a
 * system-prompt announcement. The browser half (./client) renders the host
 * manager and web terminal. Everything rides official NPM SDK packages —
 * no dsh source changes.
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { SshEngine } from './engine.ts'
import { DEFAULT_CONNECT_TIMEOUT_MS } from './engine/connection-pool.ts'
import { MAC_DEFAULTS, invalidateMacCache, type MacOptions } from './mac/resolve.ts'
import { readNeighborTableSync } from './mac/neighbor.ts'
import { makeRoutes } from './routes.ts'
import { HostStore } from './store.ts'
import { sshClusterTool, sshDownloadTool, sshExecTool, sshListTool, sshMacTool, sshTunnelTool, sshUploadTool } from './tools.ts'
import { mountOnce } from './mount-once.ts'
import { PLUGIN_TOOL_SECTION_ORDERS, visibleToolText } from './tool-surface.ts'

/** Stable cordis plugin name. */
export const name = 'ssh-mac'

/** Services required before the SSH surfaces can mount. */
export const inject = ['webServer', 'tools', 'systemPrompt']

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Volatile config values were committed into the running instance without a
     * remount (cordis-plugin-loader); dispatched to the owning fiber only.
     * @param paths - the changed config paths, as key arrays.
     * @mode emit
     */
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

/** Plugin config as a profile patch declares it, before schema resolution. */
export interface Config {
  /**
   * When true, a system-prompt section announces the SSH plugin to every agent
   * (tools + host store). Off by default to keep prompts clean.
   */
  announceToAgent?: boolean
  /** Master switch for the plugin (routes, tools, prompt section). */
  enabled?: boolean
  /**
   * xterm `fontFamily` for the web terminal (issue #577). Empty (default)
   * defers to the CSS chain: `--dsh-ssh-terminal-font`, then the official
   * `--ds-font-family-code` token, then the built-in monospace stack. Set a
   * Nerd Font stack here to render powerline/Nerd glyphs.
   */
  terminalFontFamily?: string
  /**
   * Ceiling for the whole pre-ready SSH sequence in milliseconds: TCP
   * connect, key exchange and user authentication (default 30000). Raise it
   * for hosts whose password authentication is slow (for example PAM / LDAP
   * behind a distant directory service).
   */
  connectTimeoutMs?: number
  /**
   * Resolve recorded hardware addresses before connecting (MAC-first). On by
   * default: with it off, hosts dial their configured address only.
   */
  macFirstEnabled?: boolean
  /** How long a resolved address is reused before resolving again (ms). */
  macResolveTtlMs?: number
  /** Record the hardware address of a host that was created without one. */
  macLearn?: boolean
  /**
   * Rewrite a host's stored address to the one the MAC resolved to, so the
   * fallback address follows the machine instead of a stale lease.
   */
  macUpdateHost?: boolean
  /**
   * Offer the private key before a stored password, so a host that accepts
   * both authenticates with the key.
   */
  preferKey?: boolean
  /** Sweep the local subnet when the neighbour table has no MAC mapping. */
  macSweep?: boolean
  /** Ceiling for one sweep phase in milliseconds. */
  macSweepTimeoutMs?: number
  /** Port probed to tell two addresses of the same MAC apart. */
  macProbePort?: number
}

/** The stable reference a `volatile()` config field resolves to; its owner updates it in place. */
interface ConfigRef<T> {
  /** @returns the field's current value. */
  get(): T
}

/** One resolved config field: a live reference, or a plain value from a hand-built context. */
type ConfigField<T> = ConfigRef<T> | T

/** The config the Host hands to {@link apply} — the runtime face of {@link Config}. */
export interface ResolvedConfig {
  announceToAgent?: ConfigField<boolean>
  enabled?: ConfigField<boolean>
  terminalFontFamily?: ConfigField<string>
  connectTimeoutMs?: ConfigField<number>
  macFirstEnabled?: ConfigField<boolean>
  macResolveTtlMs?: ConfigField<number>
  macLearn?: ConfigField<boolean>
  macUpdateHost?: ConfigField<boolean>
  preferKey?: ConfigField<boolean>
  macSweep?: ConfigField<boolean>
  macSweepTimeoutMs?: ConfigField<number>
  macProbePort?: ConfigField<number>
}

/**
 * Plugin config schema. Under the 0.1.7 settings model this schema IS the
 * entry's settings page: the Host derives one form per profile entry from it
 * and serves it through the shared configuration forms. Every field is
 * `volatile()`, which is what puts it on that page and what lets an edit reach
 * a running instance without a remount: the loader commits the new value into
 * the field's reference and announces `loader/volatile-update` on this fiber.
 */
export const Config = z.object({
  announceToAgent: z.boolean().default(false).volatile(),
  enabled: z.boolean().default(true).volatile(),
  terminalFontFamily: z.string().default('').volatile(),
  connectTimeoutMs: z.number().step(1).min(1_000).max(600_000).default(DEFAULT_CONNECT_TIMEOUT_MS).volatile()
    .description('TCP connect, SSH key exchange and user authentication timeout in milliseconds; raise it for hosts whose authentication is slow.'),
  macFirstEnabled: z.boolean().default(MAC_DEFAULTS.enabled).volatile()
    .description('Resolve a host by its recorded MAC address before connecting (MAC-first), falling back to the configured address.'),
  macResolveTtlMs: z.number().step(1).min(0).max(3_600_000).default(MAC_DEFAULTS.ttlMs).volatile()
    .description('How long a resolved address is reused in memory (ms).'),
  macLearn: z.boolean().default(MAC_DEFAULTS.learn).volatile()
    .description('Record the MAC address of a host that was created from an address alone, after a successful connect.'),
  macUpdateHost: z.boolean().default(MAC_DEFAULTS.updateHost).volatile()
    .description('When a MAC resolves to a new address, store that address on the host so the fallback address stays current.'),
  preferKey: z.boolean().default(true).volatile()
    .description('Try the private key before a stored password (a host with both then authenticates by key).'),
  macSweep: z.boolean().default(MAC_DEFAULTS.sweep).volatile()
    .description('When the neighbour table has no entry for a MAC, probe the local subnet once to find it.'),
  macSweepTimeoutMs: z.number().step(1).min(500).max(60_000).default(MAC_DEFAULTS.sweepTimeoutMs).volatile()
    .description('Ceiling for one subnet sweep in milliseconds.'),
  macProbePort: z.number().step(1).min(1).max(65_535).default(MAC_DEFAULTS.probePort).volatile()
    .description('TCP port probed to tell two addresses of the same MAC apart.'),
})

/** Schema defaults, re-read for hand-built test contexts (the loader applies them normally). */
const DEFAULT_ANNOUNCE = false
const DEFAULT_ENABLED = true

/** Read one resolved config field, following the live reference the schema produces. */
function readConfigField<T>(field: ConfigField<T> | undefined, fallback: T): T {
  if (field === undefined) return fallback
  if (typeof field === 'object' && field !== null && typeof (field as ConfigRef<T>).get === 'function') {
    const value = (field as ConfigRef<T>).get()
    return value === undefined ? fallback : value
  }
  return field as T
}

/**
 * Compose the MAC-first resolution knobs from the plugin config, keeping the
 * non-tunable internals (negative-cache window, probe timeout, concurrency)
 * at their documented defaults.
 * @param config - resolved plugin config.
 */
function macOptions(config?: ResolvedConfig): MacOptions {
  return {
    enabled: readConfigField(config?.macFirstEnabled, MAC_DEFAULTS.enabled),
    learn: readConfigField(config?.macLearn, MAC_DEFAULTS.learn),
    updateHost: readConfigField(config?.macUpdateHost, MAC_DEFAULTS.updateHost),
    sweep: readConfigField(config?.macSweep, MAC_DEFAULTS.sweep),
    ttlMs: readConfigField(config?.macResolveTtlMs, MAC_DEFAULTS.ttlMs),
    negativeTtlMs: MAC_DEFAULTS.negativeTtlMs,
    probePort: readConfigField(config?.macProbePort, MAC_DEFAULTS.probePort),
    probeTimeoutMs: MAC_DEFAULTS.probeTimeoutMs,
    sweepTimeoutMs: readConfigField(config?.macSweepTimeoutMs, MAC_DEFAULTS.sweepTimeoutMs),
    sweepConcurrency: MAC_DEFAULTS.sweepConcurrency,
    sweepMaxHosts: MAC_DEFAULTS.sweepMaxHosts,
  }
}

/**
 * The loader's own record of the profile entry this instance was activated
 * from, which carries the row's raw config — the user's own declaration, as
 * opposed to the schema defaults and the inherited bundle layers. Absent on a
 * host without the loader, which reads as "the profile declares nothing".
 */
interface LoaderEntry {
  options?: { config?: unknown }
}

/** Raw config the profile declares for this entry, when the loader exposes it. */
function profileConfig(ctx: Context): Record<string, unknown> | undefined {
  const entry = (ctx.fiber as Fiber & { entry?: LoaderEntry }).entry
  const config = entry?.options?.config
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return undefined
  return config as Record<string, unknown>
}

/** Order of the announcement section within the shared tool-guidance band. */
const SECTION_ORDER = PLUGIN_TOOL_SECTION_ORDERS.ssh

/** The six agent-tool names this plugin's announcement describes. */
const SSH_TOOL_NAMES = ['ssh_list', 'ssh_exec', 'ssh_upload', 'ssh_download', 'ssh_tunnel', 'ssh_cluster', 'ssh_mac'] as const

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const SSH_GUIDANCE = '本机已安装 dsh-ssh 插件（DSH 远程 SSH 运维）：侧边栏「SSH」入口；在 dsh-web 插件全家桶仓库（packages/dsh-ssh）统一维护。能力：主机配置存 $DSH_HOME/dsh-ssh.json（默认 ~/.dsh）（可从 ~/.ssh/config 导入）；持久连接池复用长连接（空闲 30 分钟自动断开）；ssh_list 列出主机、ssh_exec 执行远程命令、ssh_upload/ssh_download 传输文件、ssh_tunnel 本地端口转发（访问远程数据库/内网服务）、ssh_cluster 按 aliases/environment/tags 至少一种非空 selector 筛选后集群并发执行；支持密钥/密码/ssh-agent 认证、passphrase 密钥、ProxyJump 跳板机（别名或 [user@]host[:port] 地址）与 OpenSSH 语义的 ProxyCommand（跳过堡垒机客户端场景，只能由用户在 GUI 配置，agent 不可写）；Web 终端走 WebSocket。限制：主机操作由用户在 GUI 中配置后 agent 方可使用；密码以明文存在用户主目录私有文件（权限 0600）；命令输出原样返回、可能含敏感信息；断线重连可能重放非幂等命令；传输/执行消耗真实远程资源，先确认再操作。路径区分：本机（dsh host）上的文件与命令一律用本地工具（read / write / edit / bash），ssh_* 工具只针对远程主机上的路径。用户提到「SSH / 远程服务器 / 服务器操作 / 跳板机 / 隧道 / 部署 / 上传下载」时即指本插件，请据此协作。'

/**
 * MAC-first addendum: how a recorded hardware address changes connecting.
 * Kept separate from {@link SSH_GUIDANCE} so the upstream text stays byte
 * identical and this branch only appends what it adds.
 */
export const SSH_GUIDANCE_MAC = '本插件是 dsh-ssh 的 MAC-first 分支（ssh-mac）。主机记录可以带 `mac`（硬件地址，如 20:bd:1d:28:be:d2）：连接时先在本机邻居表（arp -a / ip neigh）中把 MAC 解析成该机器当前的 IP，邻居表没记录时按本机网段扫一遍，解析失败才用记录里的 host 兜底——DHCP 换地址、换网段后不必改配置。跳板机（proxyJump 的别名跳）同样按 MAC 解析；ProxyCommand、主机密钥别名、密钥/密码/agent 认证都不受影响。ssh_mac 工具：action=resolve 列出每条主机当前解析到的地址与来源（neighbor / neighbor-probe / sweep / cache / fallback），action=set 写入某主机的 MAC（写回 dsh-ssh.json），action=clear 清除后恢复成纯地址连接。'

/**
 * Mount the SSH engine, routes, tools, and announcement.
 * @param ctx - host plugin context carrying webServer/tools/systemPrompt.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export const apply = mountOnce('dsh-ssh-mac', applyImpl)

function applyImpl(ctx: Context, config?: ResolvedConfig): void {
  // Seeding a new record from the neighbour table costs one platform call, so
  // a batch add or an ssh-config import (which creates one record per block)
  // reuses a single read for a couple of seconds instead of shelling out per
  // host.
  let seedingTable: ReturnType<typeof readNeighborTableSync> | undefined
  let seedingAt = 0
  const neighborMac = (host: string): string | undefined => {
    if (seedingTable === undefined || Date.now() - seedingAt > 2_000) {
      seedingTable = readNeighborTableSync()
      seedingAt = Date.now()
    }
    return seedingTable.byIp.get(host)
  }
  const store = new HostStore(undefined, undefined, neighborMac)
  const engine = new SshEngine(store, {
    connectTimeoutMs: readConfigField(config?.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS),
    mac: macOptions(config),
    preferKey: readConfigField(config?.preferKey, true),
  })
  ctx.effect(() => () => { engine.dispose() }, 'dsh-ssh: engine')

  const resolve = (): { announceToAgent: boolean; enabled: boolean } => {
    let enabled = readConfigField(config?.enabled, DEFAULT_ENABLED)
    // When dsh-ssh was seeded with enabled: false (e.g. from an aggregate profile
    // line), but the profile's own entry config never set the switch AND the user
    // already has active host records in dsh-ssh.json, keep the plugin enabled so
    // existing users are not broken upon upgrade (#1250).
    if (enabled === false && profileConfig(ctx)?.enabled === undefined && store.list().length > 0) {
      enabled = true
    }
    return {
      announceToAgent: readConfigField(config?.announceToAgent, DEFAULT_ANNOUNCE),
      enabled,
    }
  }

  // The /api/dsh-ssh route family + terminal upgrade.
  const { routes, upgrade, terminalSessions } = makeRoutes({ store, engine })
  let disposeRoutes: (() => void) | undefined

  // Agent tools + their prompt sections.
  const tools = [
    sshListTool(engine),
    sshMacTool(engine),
    sshExecTool(engine),
    sshUploadTool(engine),
    sshDownloadTool(engine),
    sshTunnelTool(engine),
    sshClusterTool(engine),
  ]
  let disposeTools: (() => void) | undefined

  // System-prompt announcement.
  let disposeSection: (() => void) | undefined

  // Register (or drop) every surface to match the resolved config. Each group
  // is kept under one disposer: re-registering first tears the old one down
  // so duplicate-name registrations never throw.
  const sync = (): void => {
    // A settings edit reaches this instance without a remount; apply the
    // connection ceiling before re-deriving the surfaces so connections opened
    // by the request that follows use the new value.
    engine.setConnectTimeout(readConfigField(config?.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS))
    // Resolution knobs are read on every connect, so a settings edit lands
    // without a remount; a change to them also drops addresses resolved under
    // the previous policy.
    const previousMac = engine.opts.mac
    const nextMac = macOptions(config)
    if (JSON.stringify(previousMac) !== JSON.stringify(nextMac)) {
      engine.opts.mac = nextMac
      invalidateMacCache()
    }
    engine.opts.preferKey = readConfigField(config?.preferKey, true)
    const value = resolve()
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    if (disposeRoutes !== undefined) {
      disposeRoutes()
      disposeRoutes = undefined
    }
    if (disposeTools !== undefined) {
      disposeTools()
      disposeTools = undefined
    }
    if (!value.enabled) return
    if (value.announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-ssh',
        order: SECTION_ORDER,
        // The announcement names the ssh_* tools, so it renders only while at
        // least one of them is reachable: a restriction that removes the tool
        // surface must take the guidance with it, instead of telling the model
        // to call tools this session cannot see.
        text: visibleToolText(ctx.tools, SSH_TOOL_NAMES, SSH_GUIDANCE + SSH_GUIDANCE_MAC),
      })
    }
    disposeRoutes = ctx.effect(
      () => {
        const disposers = routes.map(route => ctx.webServer.register(route))
        const upgradeDisposer = ctx.webServer.registerUpgrade(upgrade)
        return () => {
          for (const dispose of disposers) dispose()
          upgradeDisposer()
          // Dropping the routes also ends the terminal sessions they served:
          // a live shell must not outlive the surface that can reach it.
          terminalSessions.dispose()
        }
      },
      'dsh-ssh: routes',
    )
    disposeTools = ctx.effect(
      () => {
        const disposers = tools.map(tool => ctx.tools.register(tool))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-ssh: tools',
    )
  }

  // A settings edit is committed into this instance's config references and
  // announced on the owning fiber (the entry is not remounted), so the
  // surfaces are re-derived from the new values here.
  ctx.on('loader/volatile-update', () => { sync() })

  // Initial registration from the config the Host activated this row with.
  sync()
}
