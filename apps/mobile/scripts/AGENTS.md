# apps/mobile/scripts —— 起服务 · 打包 · 连设备

> 这份文件是 [`apps/mobile` 分册](../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的文件时才加载它。

```
dev.mjs   `pnpm mobile:dev` —— 挑一个能连的地址 · adb reverse · 探活后端
apk.mjs   `pnpm --filter @admin/mobile apk` —— 打 release APK（流程只跑到一半）
```

这两个脚本存在的理由是一样的：**Expo 官方那条路在 WSL 里都断了一截**，而断的地方不报错。下面每一条都是实测出来的。

## 打 APK：`pnpm --filter @admin/mobile apk`（流程跑到一半，见下）

```bash
pnpm --filter @admin/mobile apk     # = node scripts/apk.mjs
```

⚠️ **2026-09-02 这条只验到「原生模块逐个编 .aar」那一步就按用户要求停了**，
没有产出过一个真的 APK。下面三条是这一轮**实测出来的**，不是推测。

### ✅ `expo prebuild` 在 pnpm 隔离布局下能过

这是挂了很久的一个未知项：分册里一直写着「一旦需要 prebuild 就得评估
`nodeLinker: hoisted` 的代价」。**实测不需要** —— `expo prebuild --platform android`
一次通过，autolinking 正常。那个整仓开关（会连带影响 web 与 desktop 的依赖隔离）
的成本**不用付**。

### 🔴 JVM 不认 `http_proxy` 环境变量

这台机器上有 `http_proxy=http://172.17.96.1:18080`（指向 Windows 宿主）。
**`curl` 认这些环境变量，JVM 不认** —— Java 只看 `-Dhttp.proxyHost` 那类系统属性。

于是 gradle wrapper 去直连，10 秒超时：

    Downloading https://…/gradle-9.3.1-bin.zip failed: timeout (10000ms)

**一个字不提代理**，而同一个 URL `curl` 是 200 —— 看着像「gradle 的服务器挂了」。
我据此误判成「307 跳转被墙」、换了镜像，照样超时。

`scripts/apk.mjs` 现在把 shell 的代理翻译成 JVM 系统属性，**两处都要喂**：

| 喂给谁 | 怎么喂 | 为什么 |
|---|---|---|
| wrapper 那个 JVM | `GRADLE_OPTS` | 它负责下载 gradle 发行版 |
| gradle **daemon** | `android/gradle.properties` 的 `systemProp.*` | daemon 是**另一个进程**，`GRADLE_OPTS` 管不到它；Maven 依赖解析在它里面跑 |

⚠️ `no_proxy` 也要翻译：Java 的 `nonProxyHosts` 用 `|` 分隔、`*` 通配，
和 shell 的逗号分隔不一样。

### 🔴 `babel-preset-expo` 必须显式声明，否则**只有打包会炸**

`babel.config.js` 写着 `presets: ['babel-preset-expo']`，而 babel 是
**相对配置文件所在目录**解析预设的 —— pnpm 隔离布局下 `apps/mobile/node_modules`
里根本没有这个包（它只在 store 里）。

**`expo export` 一路都是绿的**（验了十几次）：Expo CLI 从**自己的位置**解析
transformer，在 store 里看得见。gradle 的 `createBundleReleaseJsAndAssets`
走的是另一条路径、解析起点不同，就炸了 —— 而且是**跑了 19 分钟原生编译之后**
才炸在最后那个 JS 打包步骤上：

    Failed to construct transformer: Error: Cannot find module 'babel-preset-expo'

和根 `CLAUDE.md`「结构」一节那条硬纪律同一个物种（`apps/web` 漏声明
`@admin/platform`）：**用到什么就在 `package.json` 里声明什么**，
别指望「别人顺带装上了」。

### 其他

- `android/` 和 `local.properties` 都是 gitignore 的（CNG：原生工程可再生）。
  所以 gradle 镜像、代理、SDK 路径这些**只能在 `scripts/apk.mjs` 里每次重写** ——
  改完提交不进版本库，下一次 `prebuild --clean` 就回到原样
- `release` 用的是模板自带的 **debug keystore**，所以能直接出可安装的包。
  🔴 真发版要生成自己的 keystore（`android/app/build.gradle` 里有注释提醒）
- 🔴 `EXPO_PUBLIC_API_BASE` 要在打包时显式给成生产地址。它是**构建期替换的
  字符串**，不给就是 dev 的 `http://127.0.0.1:8088` —— 装到手机上第一个请求
  就连不上，而报错只说「连不上服务器」。（App 里能改，见
  [`src/app/` 分册](../src/app/AGENTS.md) 的设置一节，但一个装上就连不通的包不该发出去）
- `app.json` 里 `android.edgeToEdgeEnabled` 已删：Android 16 起 edge-to-edge
  是强制的，那个键被 Expo 废弃了，prebuild 会警告

## dev.mjs 替你做的四件事

`pnpm mobile:dev` = `node scripts/dev.mjs`。直接跑 `expo start` 有**四处会静默地不对**：

| 它替你做的事 | 不做会怎样 |
|---|---|
| 算出一个**真能连的地址**，用 `EXPO_PACKAGER_HOSTNAME` 钉住 | Metro 从网卡列表里挑一个 **docker bridge**（这台机器有 8 个）打印成 `exp://172.24.0.1:8800` —— 在 WSL 里、在 NAT 后面、还是 docker 内部网桥，三重不可达 |
| 注入 `EXPO_PUBLIC_API_BASE` | App 打的后端地址和 Metro 的不是一回事，写死哪个都会错一半 —— 表现是 App 起得来、所有请求 `Network request failed`，看着像后端挂了 |
| 端口固定 **8800** + 被占时**直接报 pid 退出** | Expo 默认 8081 太容易撞，撞了它**默默漂到 8082** —— 打印的地址就是错的，「地址看着有、就是不通」比连不上难查得多 |
| 自己去 `~/Android/sdk` 找 `adb` | 这台机器的 shell 里 `ANDROID_HOME` 没设、`adb` 不在 PATH 上，涉及设备的分支全都静默走不到 |

🔴 **它刻意不自动追加 `--android`。** 试过，是个坏设计：设备刚开机时 package 服务
还没起（`cmd: Can't find service: package`），`--android` 会让 expo **整个进程退出** ——
一个瞬时的设备状态变成了「dev server 起不来」。

`start:plain` 是不带这层的原始 `expo start`，排查这层本身有没有问题时用。

## 设备：用**宿主机（Windows）侧**的 Expo Go，不要在 WSL 里跑模拟器

🔴 **WSL 内的 Android 模拟器这条路已经放弃了，不要再往回走。**
它能跑通（两条实测就是在上面跑的），但兼容性代价太高，实测踩到的：

| 症状 | 真因 |
|---|---|
| `libpulse.so.0: cannot open shared object file` | 系统缺库，`-no-audio` 不管用（链接期就死） |
| `ProbeKVM: This user doesn't have permissions` | 不在 `kvm` 组 → 只能 `-accel off`，开机 9 分钟 |
| `no Qt platform plugin could be initialized` | 非交互 shell 里 `DISPLAY` 是空的；设了又只有 `xcb` 插件、没有 `wayland` |
| `screencap` 超时 / 画面全黑 | 软件 GPU 下 SurfaceFlinger 僵死，换 `-gpu guest` 也一样 |
| 装的 App 每次开机都没了 | AVD 的 `disk.dataPartition.path = <temp>`，数据分区是临时的 |
| `pm` / `dumpsys` 返回**空输出**而不是报错 | 机器太慢，「没装」和「服务还没起」长得一模一样 |

每一条都能修，但加起来是一条**长期不稳的验证链路**，而且和被测代码毫无关系。

### 两条外部路径

`scripts/dev.mjs` 会按情况打印**一个**地址，照着填就行。

**① 宿主机（Windows）上的模拟器 —— 现在就能用**

```bash
pnpm --filter api dev:host        # 🔴 后端要绑 0.0.0.0，不是默认的 dev
pnpm mobile:dev                   # 打印 exp://<WSL的eth0>:8800
```

地址用 **WSL 自己的 eth0 地址**（脚本自动探），Windows 侧的模拟器能直接路由到 ——
AVD 是 NAT 在 Windows 后面的，由 Windows 替它路由到 `vEthernet (WSL)`。

🔴 **不要用 `10.0.2.2`，在这台机器上它不通。** 那个别名指向**宿主机的 loopback**，
要靠 WSL2 的 `localhostForwarding` 把 Windows 的 localhost 转进 WSL —— **实测没转**
（Windows 侧的适配器名是 `vEthernet (WSL (Hyper-V firewall))`，Hyper-V 防火墙介入了）。

症状很有迷惑性：Expo Go 报 `Packager is not running at http://10.0.2.2:8800`，
而同一时刻在 WSL 里 `curl 127.0.0.1:8800/status` 是好的 —— 看着像 Metro 没起来。

**最省事的判据**：在模拟器的浏览器里开这两个，看哪个出 `packager-status:running`：

```
http://10.0.2.2:8800/status
http://<WSL的eth0>:8800/status      # ip -4 addr show eth0 | grep -oP 'inet \K[\d.]+'
```

浏览器测比 Expo Go 干净 —— 只验网络，不掺 SDK / bundle / manifest。

🔴 **用 WSL 的 IP 就必须 `pnpm --filter api dev:host`。**
`pnpm --filter api dev` 绑的是 `127.0.0.1`，从 eth0 那个地址打不进去，而这个失败
**要到你在 App 里点登录时才现形**（`Network request failed`，看着像后端挂了）。
`scripts/dev.mjs` 现在会**主动探一下**后端在选定地址上通不通，直接把结论打出来 ——
不是打一句警告完事。

🔴 **而且打不通时它会把「真凶」指出来**（pid + 那条没有 `--host` 的命令行）。
这一步是**踩两次之后**补的，第二次的样子值得记下来：

| | |
|---|---|
| 症状 | App 里的报错**一字不变**（`Can't reach the server (http://<eth0>:8088)`），看起来像「按提示做了但没用」 |
| 真因 | 后端**确实重启过了**（pid 都换了），但重启时敲的还是 `pnpm dev` —— 手顺。那条脚本没有 `--host` |
| 为什么原来的提示不够 | 「它多半还绑在 127.0.0.1 上，换成 dev:host」是**通用建议**；而人已经以为自己换过了。「你现在这个进程就是那个毛病，pid 在这」才读得进去 |

判据：`ps` 里找 `uvicorn backend.main:app` 且命令行里**没有** `--host`。
⚠️ 找不到时照旧打通用建议 —— 后端压根没起时这里就是空的，那时候「没在跑」本身是答案。

⚠️ **重启要整体停 `pnpm dev` 再起**，不要单杀那个 pid：turbo 的 persistent 任务
被单杀会连带把整条 pipeline 拖崩（另一条实测）。

⚠️ 绑 `0.0.0.0` 在这里**不等于暴露到局域网** —— WSL2 是 NAT 的，只有 Windows 宿主
够得着（这正是当初否掉 mirrored / portproxy 想保住的性质）。

⚠️ eth0 地址**每次 WSL 重启都会变**，所以脚本每次现探，不要写死到任何配置里。

**换地址**：`MOBILE_HOST=<地址> pnpm mobile:dev`

| 地址 | 什么时候用 |
|---|---|
| WSL 的 eth0 地址 | **默认**，标准 AVD 走这个 |
| `10.0.2.2` | 换台机器 localhostForwarding 是好的，或第三方模拟器路由不到 WSL 网段 |
| `127.0.0.1` | USB 真机 / WSL 内设备，配 `adb reverse`。脚本检测到本地设备时自动选 |

不要用 Windows 的局域网地址（`ipconfig` 里 Wi-Fi 那个）—— Windows 上没有进程
监听 8800，要让它转发就得 `netsh portproxy`，那条已经被否掉了。

⚠️ **Expo Go 一个客户端只支持一个 SDK。** 工程是 SDK 57，手机/模拟器上装的
Expo Go 也得是 57（`https://expo.dev/go` 下，或用 `~/.expo/android-apk-cache/`
里 expo 自己下好的那份）。版本不对的表现是一屏「出错了」，不提 SDK 两个字。

### ❌ 局域网那三条解法仍然不能用

| 解法 | 为什么 |
|---|---|
| `expo start --tunnel`（ngrok） | 隧道端点被墙，`CommandError: failed to start tunnel`。所以**刻意不装 `@expo/ngrok`** |
| `.wslconfig` 的 `networkingMode=mirrored` | 🔴 会把 WSL 里监听 `0.0.0.0` 的服务一起暴露到局域网 —— 这台机器上跑着 `fba_mssql`（1433）和 `fba_redis`（6380）。**已被否掉，不要再提议** |
| `netsh interface portproxy` | 同理，显式往局域网开口。**已被否掉** |

上面两条外部路径都**不碰局域网**：走的都是「宿主机 loopback + WSL2 自带的
localhostForwarding」，只有这台 Windows 自己够得着。
