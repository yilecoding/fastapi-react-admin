> **fastapi-react-admin** 的桌面客户端 —— 把 web 后台装进 Electron 外壳，
> 提供浏览器给不了的四件事：静默打印、本地硬件、凭据托管、自动更新。
> 后台本身（页面、权限、多页签）和浏览器版是同一份代码。

## 下哪个

| 平台 | 文件 | 说明 |
|---|---|---|
| Windows 10/11 x64 | `admin-desktop-<版本>-setup.exe` | NSIS 安装向导，**装到当前用户**（`%LOCALAPPDATA%\Programs`），不需要管理员 |
| macOS Apple Silicon | `...-arm64.dmg` | M1 及以后 |
| macOS Intel | `...-x64.dmg`（文件名不带 arm64） | |
| Linux x64 | `...-x86_64.AppImage` | `chmod +x` 后直接运行，不用装 |

`.blockmap` 与 `latest*.yml` 是**自动更新**用的，人不需要下载。

## 装完第一件事：填后端地址

首次启动会让你填**服务器地址**（如 `https://admin.example.com`）。它是**运行期配置**，
存在用户目录里 —— 所以同一个安装包可以连不同环境，不用为每个环境各打一版。

## 已知限制（都是刻意的取舍，不是漏做）

- 🔴 **所有平台的包都没有代码签名。**
  - Windows：SmartScreen 会拦一次 →「更多信息」→「仍要运行」
  - macOS：Gatekeeper 会说**「已损坏，应移到废纸篓」**。这不是包坏了，是没有公证：
    右键 →「打开」，或者 `xattr -dr com.apple.quarantine /Applications/Admin\ Desktop.app`
  - 正式交付请在有证书的机器上打包（Windows 代码签名证书 / Apple Developer ID + notarize）
- 🔴 **macOS 上的自动更新不工作**（未签名）。electron-updater 要校验运行中应用的代码签名，
  拿不到就拒绝安装更新。Windows 与 Linux(AppImage) 的自动更新正常
- **读卡器等本地硬件是桩模式**：厂商的原生助手不在仓库里（那是现场的东西），
  所以这个包里没有。界面上相关功能会走模拟数据
- **打印**：Windows 上是真的静默打印；macOS/Linux 上打印链路能跑，但没有在真机标签机上验过

## 更新从哪来

默认读这个仓库的 Release。内网部署（客户出不去公网）可以在客户机的 `config.json` 里
填 `updateUrl`，指向自己的静态目录 —— **不用为内网单独打一版**。

---
