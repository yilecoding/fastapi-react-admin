# apps/mobile/e2e —— 移动端 E2E（Maestro · Android 模拟器 · 只在 CI 里跑）

> 这份文件是 [`apps/mobile` 分册](../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的
> 文件时才把它加载进上下文（惰性加载）。跨模块的硬纪律只在根 `CLAUDE.md` 里有一份；
> **新增结论请追加到离代码最近的那一份**。

```
setup.mjs            关登录验证码 · 造测试数据 · 把流程要的值打成 `MAESTRO_XXX=…`
subflows/login.yaml  冷启动 → 清登录态 → 账号密码登录（两条流程共用）
flows/admin-users.yaml   登录 → 应用页 → 用户列表翻页 → 搜索 → 详情 → 删除确认 → toast
flows/perm-gate.yaml     没角色的账号：应用页没有「用户」，并且明说「没有授权」
```

跑的地方是 `.github/workflows/ci.yml` 的 `maestro · 移动端 E2E`（#137）：起后端（和
`playwright · E2E` 同一份 `.env.e2e`、同一个 `fba_test`）→ 打 x86_64 的 release APK →
起模拟器 → `maestro test apps/mobile/e2e/flows`。

- **只跑 Android。** iOS 要 macOS runner，没做
- **不在 ruleset 的必需检查里。** 先观察稳定性再决定进不进
- **PR 上按路径触发**（`changes` job 的 `mobile` 输出）：`apps/mobile` · `packages/api` ·
  `packages/i18n` · `pnpm-lock.yaml` · `.github/workflows/ci.yml`。后端改动不触发；main 上每次 push 都跑
- ⚠️ **本地没跑过。** 这台机器 WSL 里起模拟器那条路已经放弃（见 [`scripts/` 分册](../scripts/AGENTS.md)），
  这一套从头到尾是在 CI 上调通的。本地要跑的话思路是：后端起在一个测试库上 →
  `export $(node apps/mobile/e2e/setup.mjs)` → 设备上装一个连得到它的包 → `maestro test`，
  但**这条没验过**

## 它挡什么、不挡什么

挡得住「打出来了但起不来 / 登不进去 / 列表翻不动 / 删除没反应」—— `expo export` 那道闸门
挡不住的那一类。**挡不住视觉问题**（#96 那个「英文下表单标签换行」）：Maestro 的断言只管
元素在不在。

## 🔴 全程按 `testID` 找元素，不按文字

界面语言跟着设备语言走（`src/lib/i18n.ts`），**CI 模拟器默认是英文** —— 按中文文案找，
一条都找不到。实测截图：登录屏的标题是「Sign-in」。

为此补了两处原来没有 `testID` 的地方：

| 哪里 | `testID` | 为什么原来没有 |
|---|---|---|
| 底部页签（`(tabs)/_layout.tsx`） | `tab-home` / `tab-apps` / `tab-profile`（`tabBarButtonTestID`） | 页签是 react-navigation 的原生组件，不是自己写的 `Pressable` |
| toast（`ui/toast.tsx`） | `toast-<tone>`，如 `toast-success` | —— |

加新流程时缺 `testID` 就补，**不要退回按文字找**。

## 🔴 构建要钉 JDK 17

runner 默认的 JDK 是 25。不钉的话 `assembleRelease` 挂在原生模块的 CMake 配置上：

    Execution failed for task ':react-native-worklets:configureCMakeRelWithDebInfo[x86_64]'.
    > WARNING: A restricted method in java.lang.System has been called

**一个字不提 JDK 版本** —— 那句 WARNING 是新 JDK 打到 stderr 的，被当成了失败原因。
runner 镜像自带 17（`$JAVA_HOME_17_X64`），指过去就行，不用装。

实测（2026-11-16，同一份工程）：默认 JDK（`openjdk 25.0.5`）3 分 23 秒后失败在
`react-native-worklets` 和 `react-native-screens` 两个任务上；钉到 17 之后
`BUILD SUCCESSFUL in 9m 12s`（冷缓存、只编 x86_64）。

## 🔴 模拟器用纯 AOSP 镜像（`target: default`），不用 `google_apis`

`google_apis` 镜像开机后桌面会 ANR，弹一个系统对话框盖在 App 上。Maestro 报的是

    Assertion is false: id: login-username is visible

看着像 App 没渲染出来。**其实渲染好了** —— 失败截图里登录屏完整，上面盖着
「Pixel Launcher isn't responding」。

实测（2026-11-16）：`google_apis` 两条流程都死在这一步；换成 `default` 并加
`adb shell settings put global hide_error_dialogs 1` 之后登录屏正常可见。
⚠️ 两处是一起改的，没有分开验哪一处起的作用。

## 🔴 启动要包一层 `retry`（`subflows/login.yaml`）

第二条流程起来时屏上只有一张启动图，60 秒不动，后端一个请求都没收到。
**不是 App 卡死**，是系统侧的竞态 —— 上一条流程把 App 留在前台，`clearState` 杀掉旧进程、
紧接着拉起新进程，而系统清理旧任务的那一下晚到，把刚起来的新进程一起杀了。
logcat（2026-11-16）：

    08:37:14.150 Start proc 2850:com.fastapireactadmin.mobile
    08:37:14.168 Destroy timeout of remove-task, attempt to kill Task{… #8 …}
    08:37:14.181 Killing 2850:com.fastapireactadmin.mobile (adj -10000): remove task
    08:37:24.156 Process ProcessRecord{… 2850:…} failed to attach

所以判断「启动卡住」之前先看 logcat 里新进程还在不在。

现在的写法是 `retry` 里先 `stopApp` 再 `launchApp: { clearState: true }`。
实测（同一天下一轮）：两条流程都过，`retry` 块各 4 秒就结束 —— **第一次尝试就成了，
重试没有真的触发过**。所以起作用的多半是前面那句 `stopApp`（或者只是这一轮没撞上），
`retry` 是留着兜底的，没被验证过。

## ⚠️ 测试包放开了明文 HTTP，发版的包没有

CI 里的后端只有 `http://`。prebuild 生成的 `android/app/src/main/AndroidManifest.xml`
里 `<application>` 没有 `android:usesCleartextTraffic`（只有 debug 那份清单有），
所以 CI 在 prebuild 之后用 `sed` 给 main 清单加上，**只影响这一次构建**，不改 `app.json`。
后面跟着一句 `grep` 当守卫：模板哪天换了写法、`sed` 没替换上，要当场红。

⚠️ 「不加就连不上」**没有做对照**（没跑过不加这一行的包）。能确定的只有：加了之后
App 从模拟器里经 `http://10.0.2.2:8001` 打通了后端（后端日志里有它的请求）。
推论是 `pnpm --filter @admin/mobile apk` 打出来的包连不了 `http://` 的后端 —— 设置屏
允许填这种地址。**这条是推论，没验。**

## 测试数据：`setup.mjs`

- 关验证码照 `apps/web/e2e/global-setup.ts` 的写法（无条件写一次再回读，理由在那个文件的头注释）
- 种子里只有 10 个用户，不到一页（`PAGE_SIZE = 20`），所以先补到 25 个，翻页才有第二页可翻
- 「第二页第一条」的 ID 是脚本按 App 自己的分页参数（`page=2&size=20`）问后端问出来的，
  流程里 `scrollUntilVisible` 等的就是它 —— 只有真的拉了下一页它才会出现
- `roles: []` 的用户能建、能登录，应用页显示 `apps-none-granted`、没有 `module-users`（`perm-gate` 那条过了）
- 🔴 `PAGE_SIZE` 和 `src/lib/users.ts` 里那个**是两份**，改一处要改另一处
- `MAESTRO_` 开头的环境变量 Maestro 会自动带进流程，所以 CI 把脚本的输出追加进 `$GITHUB_ENV`。
  🔴 **不要写成 `node setup.mjs | tee -a "$GITHUB_ENV"`**：那一步的 shell 没开 `pipefail`，
  脚本挂了管道照样返回 0（这条是按 bash 的语义写的，没在 CI 上故意弄挂验过）

## 其他

- `EXPO_PUBLIC_API_BASE=http://10.0.2.2:8001` 是**构建期**焊进 APK 的，要在打包那一步之前就在环境里。
  模拟器里 `10.0.2.2` 是宿主机的回环，所以后端绑 `127.0.0.1` 就够（`e2e_server.py` 就是这么绑的）。
  ⚠️ 这和本机 WSL 上「`10.0.2.2` 不通」不矛盾，那是 WSL 的转发问题
- Maestro 钉了版本和 `maestro.zip` 的 sha256，不走官方的 `curl | bash`。升级时两个值一起换
- 没缓存 AVD 快照：仓库缓存上限 10 GB，怕挤掉 pnpm / uv / Gradle 的
- 耗时（2026-11-16 跑通的那一轮，Gradle 冷缓存）：整个 job **17 分钟**，其中打 APK 12 分半、
  起模拟器 + 装包 + 两条流程 2 分 40 秒（流程本身 1 分 21 秒）。
  ⚠️ Gradle 缓存只有 main 上的运行会写（`setup-gradle` 的默认行为），所以 PR 上要等这个 job
  在 main 跑过一次之后才吃得到缓存 —— 缓存命中后能快多少**还没测**
- 失败时的截图、界面层级、logcat 都在 `maestro-debug` 这个 artifact 里。
  **排错先看截图** —— 上面两个坑都是截图和 logcat 说清楚的，Maestro 自己那句报错两次都指错了方向
