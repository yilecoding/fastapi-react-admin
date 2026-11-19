# 搜索引擎收录（站长平台）

文档站有两份，内容一样，分开给国内和海外的搜索引擎：

| 站点 | 地址 | 给谁 | sitemap |
|---|---|---|---|
| 国内 | https://fra.wubunan.com/docs/ | 百度（主推） | `https://fra.wubunan.com/docs/sitemap-0.xml` |
| 海外 | https://yile2020.github.io/fastapi-react-admin/ | Google、Bing | `https://yile2020.github.io/fastapi-react-admin/sitemap-index.xml` |

两份都是中文在根路径、英文在 `/en/`。每页的 canonical 指向自己那份，不会被当成重复内容。

## 🔴 GitHub 改名后要做的（yilecoding → yile2020，2026-11-19）

改名后旧的 `yilecoding.github.io/fastapi-react-admin/` 整站 404，GitHub **不会**给 Pages 做跳转（仓库页和 raw 会跳）。
Google 那边收录的、文章里链出去的旧地址全部失效。国内那份 `fra.wubunan.com/docs/` 和百度**不受影响**。

- [x] 用新账号把 `yilecoding` 占住（2026-11-19）。这个账号下**不要建 `fastapi-react-admin` 仓库**，会顶掉旧仓库地址的跳转
- [x] 代码里的站点地址改成新名（#389，2026-11-19 合并）。Pages 已重新发布，sitemap、canonical、og:url 都是新名（第一次发布遇到 GitHub 偶发错误，重跑后成功）
- [x] **旧地址做跳转**（2026-11-19 做完：仓库 `yilecoding/yilecoding.github.io`，三个文件已上传，Pages 自动用 main 根目录；实测旧地址带路径 / 参数 / 锚点都跳到新站同一页）：在 `yilecoding` 账号下建仓库 `yilecoding.github.io`（用户站点，名字必须一字不差），
      放 Claude 准备的三个文件（`404.html` · `index.html` · `fastapi-react-admin/index.html`），Settings → Pages 选 main 分支根目录。
      效果：`yilecoding.github.io/fastapi-react-admin/<任意路径>` 自动跳到 `yile2020.github.io/fastapi-react-admin/<同一路径>`。
      它和「不要建 `fastapi-react-admin` 仓库」不冲突 —— 是另一个仓库名
- [x] **Google Search Console 加新资源**（2026-11-19 做完：资源 HTML 文件自动验证通过 · `sitemap-index.xml` 已提交 · 首页和 `/en/` 已请求编入索引）：网址前缀 `https://yile2020.github.io/fastapi-react-admin/`，选「HTML 文件」验证。
      验证文件 `google354ce5fed9937af4.html` 已经在新地址上（验证码绑的是 Google 账号，不是网址，同一个文件能用），直接点验证。
      然后提交 sitemap `sitemap-index.xml`，首页和 `/en/` 各「请求编入索引」一次
- [ ] 旧资源（`yilecoding.github.io/…`）**先别删**：里面有到现在的收录和搜索词数据，做了跳转后还能看到 Google 把旧页挪到新地址的过程。
      「设置 → 地址更改」工具用不了（它只认域名根，子路径的 github.io 资源不支持），靠跳转 + 新 sitemap 让 Google 自己迁
- [x] Bing（2026-11-19 做完：从 GSC 导入，新站和 `sitemap-index.xml` 都过来了，状态 Processing）：上面新资源验证好之后再「从 Google Search Console 导入」，导进来就是新地址
- [x] 服务器上国内文档站重新拉一次包（2026-11-19 拉完，页面里已是新名；服务器到 github.io 只有 ~40KB/s，要先整包下载到文件再解压，管道直解会超时）（拉的是新地址的 `docs-site.tar.gz`）：现在页面里的 GitHub 链接还是旧名（会跳转，不急）
- [x] （2026-11-19 做完：zread 新地址 200 正常；DeepWiki 新名下原是「Repository Not Indexed」，已填通知邮箱点了 Index Repository，状态 Indexing in Progress，建完发邮件，2–10 分钟）DeepWiki / zread：两家按仓库路径建索引。zread 新旧地址都能开；DeepWiki 打开 `deepwiki.com/yile2020/fastapi-react-admin`，没有内容就点重新索引

## 进度

### 百度搜索资源平台 https://ziyuan.baidu.com

- [x] 添加站点 `https://fra.wubunan.com`，HTML 标签验证（2026-11-02）
- [ ] （2026-11-19 实看：sitemap 那栏今日提交上限 0、存量文件上限 0、提交按钮是灰的，页面上已经没有「去填写」入口，备案号没填）「资源提交 → 普通收录 → sitemap」下面点「去填写」，填 `wubunan.com` 的**主体备案号**（`X ICP备xxxxxxxx号`，不带 `-1`）。
      备案号在腾讯云控制台 https://console.cloud.tencent.com/beian 「我的备案」里，或者 https://beian.miit.gov.cn 查 `wubunan.com`
- [ ] 隔几天回来看「今日提交上限」。不是 0 了就提交：
      ```
      https://fra.wubunan.com/docs/sitemap-0.xml
      ```
      ⚠️ **不要提交 `sitemap-index.xml`**：百度不再支持索引型 sitemap，提交了也不抓
      （[百度搜索学堂：普通收录](https://ziyuan.baidu.com/college/courseinfo?id=267&page=2)）
- [x] 「手动提交」先交这几页（2026-11-19 交了，提示「链接提交成功」；API 提交没用）：
      ```
      https://fra.wubunan.com/docs/
      https://fra.wubunan.com/docs/getting-started/quick-start/
      https://fra.wubunan.com/docs/guides/first-module/
      ```

配额是百度按站点质量评估的，新站是 0 很正常；填备案号有帮助，但不保证马上放开。
**配额一直是 0 也没关系**，robots.txt 已经放行 `/docs/`，百度蜘蛛自己会来，只是慢（以周计）。

### Google Search Console https://search.google.com/search-console

- [x] 添加资源「网址前缀」`https://yilecoding.github.io/fastapi-react-admin/`（改名前的旧地址），HTML 文件验证（2026-11-02）。新地址的资源见上面「GitHub 改名后要做的」
- [x] 提交 sitemap `sitemap-index.xml`（刚提交时显示「无法抓取」、上次读取时间为空，是 Google 还没去读，不是错）
- [ ] 11/4 前后回来看 sitemap 状态。还是「无法抓取」就再提交一个 `sitemap-0.xml`，仍不行截图找 Claude
- [x] （可选）顶部搜索框输入首页地址 →「请求编入索引」，`/en/` 也来一次（2026-11-19 在新资源 `yile2020.github.io` 上都请求了，进了优先抓取队列）
- [x] （2026-11-19 做完：同一个 `google354ce5fed9937af4.html` 就能自动验证，不用再放文件；`sitemap-index.xml` 已提交）（可选）再加一个网址前缀资源 `https://fra.wubunan.com/docs/`，把给的 `googleXXXX.html` 文件名交给 Claude 放到服务器上

不要加 robots.txt：GitHub Pages 的 robots.txt 只认 `yile2020.github.io/robots.txt`（域名根，归 `yile2020.github.io` 这个仓库管，我们没建），我们的站在子路径下放了也不生效。
根上没有 robots.txt = 全部放行，现在就是最好的状态。

### Bing Webmaster https://www.bing.com/webmasters

- [ ] 登录后选「从 Google Search Console 导入」，授权即可，站点和 sitemap 一起过来，不用再验证。
      Bing 的索引也供给 DuckDuckGo、ChatGPT 搜索等

### GitHub 仓库

- [x] （用户已配好，2026-11-19 核对：预览图是品牌图，带新名）Settings → General → Social preview → Edit → Upload，传 `og-preview.jpg`（Windows 桌面上；源图是 https://yile2020.github.io/fastapi-react-admin/og.png）。
      直接传 og.png 报过「Something went really wrong」，换成去掉透明层的 JPG 再传
- [x] （2026-11-19 `gh repo edit --homepage` 改成了 `https://yile2020.github.io/fastapi-react-admin/`，原来是演示站 `https://fra.wubunan.com`）（可选）仓库首页右侧 About 的 Website 改成文档站地址

## 之后什么时候回来看

- [ ] **11/9 周一**：Google「网页」报告看收录了几页（总共 34 页）；百度看配额放开没有
- [ ] **11/16 周一**：Google「效果」看有哪些搜索词带来展示；百度「索引量」
- [ ] 之后每月看一次。收录少或报错，截图找 Claude

## 这些东西放在哪，不要删

| 东西 | 位置 | 删了会怎样 |
|---|---|---|
| 百度验证 meta | 服务器 `/www/server/panel/vhost/nginx/extension/fra.wubunan.com/baidu-verify.conf`（只给首页 `/` 插一行 meta，不进仓库：别人 fork 不该带着我们的验证码） | 百度定期复查，验证失效 |
| Google 验证文件 | 仓库 `main` 的 `apps/docs/public/google354ce5fed9937af4.html`（#208） | 同上 |
| 文档站的 nginx 配置 | 同目录的 `docs.conf`：`/docs/` 静态文件 + 只放行 `/docs/` 的 robots.txt | 国内文档站 404 |
| 文档站文件 | 服务器 `/www/wwwroot/fra.wubunan.com/docs/`（上一版在 `docs.old`，回滚就换回来） | —— |

**文档更新后**：GitHub Pages 那份合进 `main` 自动更新；服务器那份要重新拉包，命令在 `main` 的 `apps/docs/AGENTS.md`，或者直接让 Claude 拉。
想自动化可以在宝塔加一个每天跑一次的计划任务（还没加）。
