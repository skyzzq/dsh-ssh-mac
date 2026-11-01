# 发布到 dsh 插件市场

市场列表不在插件应用仓库里，而在精选列表 `awesome-dsh-plugin`。往 dsh-market 提条目没用，收录走那边的一条 YAML。

## 当前进度

| 事项 | 状态 |
| --- | --- |
| 仓库 `skyzzq/dsh-ssh-mac` | 已建（公开，2026-11-01T11:21Z） |
| 源码推送 | 已推，`main` = `765e006`，65 个文件，`lib/` 预构建产物在库里 |
| `dsh.bundle` 声明 | 远端 `package.json` 已核对 |
| 条目文件 | `docs/awesome-entry-skyzzq__dsh-ssh-mac.yml` |
| 发布 tarball | `release/dsh-ssh-mac.tgz`（407 KB，51 个文件） |
| `dsh-plugin` topic | 待加（需网页或 token） |
| release `v1.0.0` + 附件 | 待建（需网页或 token） |
| awesome-dsh-plugin PR | 待提，且需仓库满 1 天：2026-11-02T11:21Z 之后 |

本机 SSH 私钥 `~/.ssh/id_ed25519` 已被 GitHub 认作 `skyzzq`，推送走 SSH 即可；API 类的动作（topic、release、PR）没有凭据就做不了。


## 两条路

一条是发 npm 包（安装时免构建授权），一条是把预构建 tarball 挂 GitHub Release（脚本已按第二种准备）。两者可以都做。

## 需要的东西

一个 GitHub 账号，以及一个有 `repo` 权限的 token。本机当前没有可用凭据：`npm whoami` 未登录、`gh` 未安装、`~/.git-credentials` 为空、环境变量里没有 `GH_TOKEN`。

## 一条命令跑完

```bash
cd dsh-ssh-mac
node scripts/prepare-publish.mjs --owner <你的 GitHub 账号>   # 写 package.json 坐标 + 生成条目 + 打 tgz
GH_TOKEN=<token> node scripts/publish-github.mjs --owner <你的 GitHub 账号>
```

`publish-github.mjs` 依次做：建公开仓库 → 提交并推送 → 加 `dsh-plugin` topic → 建 release 并上传 `release/dsh-ssh-mac.tgz` → 仓库满 1 天后往 `awesome-dsh-plugin` 提 PR。不满一天时它会打印还差几小时并退出，第二天重跑同一条命令即可。

## 手动跑（不想给 token 时）

1. 在 GitHub 建公开仓库 `dsh-ssh-mac`，把本目录推上去。
2. 仓库 Settings 里加 topic `dsh-plugin`。
3. 建 release `v1.0.0`，把 `release/dsh-ssh-mac.tgz` 作为附件上传（文件名不带版本号，`latest/download/` 是照字面取的，带版本号下次发版就 404）。
4. fork `awesome-dsh-plugin`，新建 `data/plugins/<账号>__dsh-ssh-mac.yml`，内容用 `docs/awesome-entry-<账号>__dsh-ssh-mac.yml`。
5. 对 `awesome-dsh-plugin/awesome-dsh-plugin` 的 `main` 提 PR。只加这一个文件，别顺手改别人的条目。

条目格式（字段就这些，多写会被 lint 拒）：

```yaml
url: https://github.com/<账号>/dsh-ssh-mac
name: <账号>/dsh-ssh-mac
category: remote
description:
  en: Resolves an SSH host by its NIC MAC address before dialing, so DHCP address changes stop breaking saved hosts.
  zh: 建链前先按网卡 MAC 把主机解析成当前 IP，DHCP 换号不用改配置。
```

分类取 `remote`：这一类是 SSH、远程执行、跳板之类的远程操作。分类选偏了维护者会直接改，不会打回。

## 发 npm（可选）

```bash
npm login
npm publish --access public
```

发布后条目里不用加 `tarball:`，市场会优先走 npm 的预构建安装。名字 `dsh-ssh-mac` 目前未被占用。

## 被打回时看什么

描述与代码不符是主要打回原因，改那一行就行。要改条目只改自己的 YAML，不要手改 README，那边的 README 由 `data/plugins/*.yml` 生成。
