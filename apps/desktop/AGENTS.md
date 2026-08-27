# apps/desktop 的打包与发布

> 外壳本身怎么用见 [`README.md`](./README.md)。这一份只讲**出包与发版** ——
> 全是「做错了不当场报错」的那类结论，多数**只在正式包里才撞得到**。
>
> 这份文件是根 `CLAUDE.md` 的**模块分册**，Claude Code 在你读到本目录下的文件时
> 才把它加载进上下文（惰性加载）。跨模块的硬纪律仍然只在根 `CLAUDE.md` 里有一份。

## 出包的顺序：漏了第一步不报错，只是界面是上一版的

```bash
pnpm --filter web build                  # ① 渲染层
pnpm --filter @admin/desktop package     # ② 主进程 + preload + NSIS → release/<版本>/
```

🔴 **①不能省，而且它不在 desktop 自己的 `build` 里。** desktop 的 `build` 只编主进程和
preload；渲染层是 `electron-builder.yml` 的 `extraResources` 从 `apps/web/dist` **抓的**。
漏了①的两种表现都不指向「忘了构建前端」：

| 情况 | 表现 |
|---|---|
| `apps/web/dist` 不存在 | 报一个 file source 不存在（还算能查） |
| 存在但是旧的 | **包出来界面是上一版的，不报任何错** |

CI 的 `release.yml` 里这两步是写死的顺序，本地手打包要自己记住。
（`turbo` 的 `@admin/desktop#build` 声明了 `dependsOn: web#build`，所以走
`pnpm build` 也对；但 `pnpm --filter @admin/desktop package` **不经过** turbo 那条依赖。）

## 三个平台：谁能打、打出来能不能用

| 平台 | 产物 | 谁能打 | 装了能用吗 | 自动更新 |
|---|---|---|---|---|
| Windows x64 | `nsis`（`.exe`） | **只能在 Windows 上**（从 mac/linux 交叉打要 Wine，不做） | ✅ SmartScreen 拦一次 | ✅ |
| macOS arm64 / x64 | `dmg`（给人装）+ `zip`（给更新器） | **只能在 macOS 上**（dmg 要 macOS 工具链） | ⚠️ 未公证 → Gatekeeper 说「已损坏」，要右键打开或 `xattr -dr com.apple.quarantine` | 🔴 **不工作** |
| Linux x64 | `AppImage` | Linux（也能在 mac 上打，但没验过） | ✅ `chmod +x` 直接跑 | ✅ |

所以 `release.yml` 是**三个 runner 的矩阵**，不是一台机器出三份。仓库是 public，
GitHub 的 macOS runner 不额外计费。

🔴 **macOS 的自动更新必须签名。** electron-updater 会校验**运行中那个应用**的代码签名，
拿不到就拒绝安装更新 —— 表现是「检查到新版本、下完了、装不上」。这不是配置能绕过去的，
要 Apple Developer ID（$99/年）+ notarize。在那之前 mac 版只能手动下 dmg 覆盖安装。

⚠️ **mac 的 `zip` target 不能省。** 更新器读的是 zip 不是 dmg，只出 dmg 的话
`latest-mac.yml` 里没有可用条目，更新链路直接断。

⚠️ 三个平台的更新清单文件名不同（`latest.yml` / `latest-mac.yml` / `latest-linux.yml`），
所以三个 job 往同一个 release 传不会互相覆盖。

### 🔴 草稿必须先建好，且只建一次

三个平台的 job 是并行的。让它们各自「没有就建一个」会撞出多个草稿 ——
GitHub 的草稿**不按 tag 去重**（实测见下面「在线更新」第 4 条）。
所以 `release.yml` 里有一个单独的 `prepare` job 先把草稿建出来，
`build` 矩阵只负责往里传文件。

## 发布的两条路线

| | 用在哪 | 产物去哪 |
|---|---|---|
| **A. GitHub Release**（本仓库默认） | 开源分发 / 自己内测 | 打 `v*` tag → `.github/workflows/release.yml` → 草稿 release |
| **B. 内网静态目录** | 交付给出不去公网的客户 | 人工/脚本把三个文件放进一个能列目录的 HTTP 目录（IIS、nginx 都行） |

两条路线**用的是同一个安装包**，区别只在「更新源指向哪」（见下一节）。

### B 路线要放的是**三个**文件，且有顺序

```
<版本>.exe          安装包本体
<版本>.exe.blockmap 差量更新用（少了它每次都是全量下载）
latest.yml          更新端要读的清单
```

🔴 **`latest.yml` 必须最后放。** 它先落地的话，中间那几秒里客户端会拿到 404 或者
半个包 —— 而这两种都不报「更新源没准备好」，只报一个下载失败。

⚠️ **`latest.yml` 那一层不能缓存**（nginx / IIS 都要显式关）。缓存住的表现是
「发了新版但客户端永远说已是最新」—— 和第 1 节那条一样，是个静默的假阴性。

## 更新源：编译期只是默认值，运行期可以逐台覆盖

`electron-builder.yml` 的 `publish` 段决定**打包时写进 `app-update.yml` 的那个源**；
`src/main/updater.ts` 启动时如果读到 `userData/config.json` 的 `updateUrl`，
就 `setFeedURL` 覆盖成 generic。所以：

- 同一个安装包发到不同部署点，更新源可以逐台机器不同
- 交付内网客户时**不用为它单独打一版**，改客户机的 `config.json` 即可

🔴 **`publish` 段不能注掉。** 它不只是「发布」用的：有它 electron-builder 才会
① 生成 `latest.yml` ② 把 `app-update.yml` 打进包里的 `resources/`。
注掉之后打出来的包，产物目录里没有 `latest.yml`、`resources/` 里没有 `app-update.yml`，
表现是**点检查更新直接报错**，而错误信息跟「打包配置」毫无关系。

## 四个坑，两个只在正式包里撞得到

### 🔴 1. `await import("electron-updater")` 在正式包里拿到的是 undefined

electron-updater 是 CommonJS，而主进程产物是 vite 打的 cjs bundle —— 这条路径上
`import()` 回的是 `{ default: { autoUpdater } }`。要 `mod.autoUpdater ?? mod.default?.autoUpdater`
两边都认。

⚠️ **开发模式永远撞不到**：`getUpdater()` 在 `!app.isPackaged` 时早退，根本不加载那个模块。
正式包里的表现是 `Cannot read properties of undefined (reading 'setFeedURL')`。

### 🔴 2. `quitAndInstall()` 默认**不是**静默安装

NSIS 是 `oneClick: false`（带向导，好处是首次安装能选目录），而 `quitAndInstall()` 的
`isSilent` 默认 `false` —— 两者一撞，拉起来的是**交互式安装向导**：应用退了、新版本没装上、
停在「下一步」等人点。无人值守的终端机上没人会去点。必须显式 `quitAndInstall(true, true)`。

判据（在自己的落盘日志里就能看到）：

```
Install: isSilent: false, isForceRunAfter: true
Update installer has already been triggered. Quitting application.
```

之后 exe 仍然是旧版本。

### 🔴 3. `perMachine` 是为自动更新选的，不是随手填的

`perMachine: false`（装进 `%LOCALAPPDATA%\Programs`）—— per-machine 装进 Program Files，
每次更新都要 UAC 提权，而终端机操作员通常不是管理员，静默更新会卡在提权对话框上。

⚠️ 机器上如果**还留着**早先 per-machine 装的那一份（同一个 `appId`），注册表 `HKLM`
的卸载项会让安装器仍然去更新旧位置 → 又要提权 → 静默失败。判据：卸载项的
`UninstallString` 带 `/allusers`，先卸掉再装新包。

### 🔴 4. 别让 electron-builder 自己往 GitHub Release 传 —— 会建出两个草稿

它的 GitHub publisher 是**每个产物一个上传任务、各自惰性建 release**。两个任务同时
看到「release doesn't exist」就各 POST 了一次，而**草稿不按 tag 去重**，于是 GitHub
老老实实建了两个。实测（v0.0.1-rc.1，2026-08-27）：

```
• publishing   publisher=Github (…)      ← 两次
• uploading    file=…setup.exe.blockmap
• uploading    file=…setup.exe
• creating GitHub release  reason=release doesn't exist   ← 也是两次
```

结果：草稿 A 只有 blockmap，草稿 B 有 exe + latest.yml，而且进程没等 90MB 的 exe
传完就退了 —— **那次运行仍然是「成功」**。

所以 CI 里跑的是 `--publish never`，产物由 `gh release upload` 自己传：没有竞态，
而且能保证 latest.yml 最后落地。`electron-builder.yml` 的 `publish` 段仍然要留着 ——
它负责生成 latest.yml 和把 app-update.yml 打进包（见上一节）。

### ⚠️ 5. 增量下载第一次通常回落成全量

`.blockmap` 让 electron-updater 只下差异块，但它要拿**本机那个旧安装包**的 blockmap 去比。
第一次更新常报 `Cannot download differentially, fallback to full download: sha512 checksum
mismatch` —— 不是故障，是本机没有匹配的旧包。之后的更新才吃到增量。

## 环境坑

### ⚠️ `EPERM: rename win-unpacked.tmp -> win-unpacked` 是杀软，不是构建配置

`package` 在解包 Electron 之后倒在 `rename('win-unpacked.tmp' → 'win-unpacked')`，
而目标目录**并不存在** —— 所以不是「目录已存在」那类问题。

按这个顺序查能直接指到人：手工删那个 `.tmp` → 报 `default_app.asar` 正被占用 →
进程列表里找不到持有者 → 查 `root/SecurityCenter2` 的 AntiVirusProduct。
真凶是企业级 AV 的实时防护抓着刚落盘的两百多 MB Electron 二进制不放（`.asar` 是压缩包，
它要扫），而它的句柄不带 share-delete，于是 rename 和 delete 都失败。

修法按代价排：给 AV 加排除（release 输出目录 + `%LOCALAPPDATA%\electron\Cache` +
`%LOCALAPPDATA%\electron-builder\Cache`，唯一的真修法）→ 重启后重跑（AV 按哈希缓存信誉，
第二次常常能过）→ 换一台没装那套 AV 的机器 / CI。

⚠️ 别去 kill 那个 AV 进程：企业策略里通常有防篡改，杀不掉还会上报。

### ⚠️ 更新缓存目录叫 `@admindesktop-updater`

electron-builder 从 `package.json` 的 `name`（`@admin/desktop`）推出来的，**不跟
`productName` 走**。它只是下载缓存，不影响功能 —— 看到这个名字别以为装错了应用。

### ⚠️ 未签名包的第一次启动会很慢

不签名的话，AV 首次扫描新 exe 的开销会落在用户的第一次操作上。正式交付要在能访问
证书的机器上打包并配 `signtoolOptions`（`electron-builder.yml` 里留了注释位）。

## 三个「发版之后就不能改」的值

`appId` · `productName` · `executableName`（`electron-builder.yml` 顶部）。
`productName` 同时是 `%APPDATA%\<它>\config.json` 的目录名 —— 改名 = 老机器上的
服务器地址 / 打印机名 / 更新源全成孤儿，表现为「更新完又要重填一遍」而不是报错；
`appId` 是 Windows 认「同一个应用的升级」的依据，改了会装出两份并存。
**接新项目时第一件事就是改掉它们，且要在第一次发版之前改完。**
