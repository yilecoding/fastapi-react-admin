# 搜索引擎收录（站长平台）

文档站有两份，内容一样，分开给国内和海外的搜索引擎：

| 站点 | 地址 | 给谁 | sitemap |
|---|---|---|---|
| 国内 | https://fra.wubunan.com/docs/ | 百度（主推） | `https://fra.wubunan.com/docs/sitemap-0.xml` |
| 海外 | https://yilecoding.github.io/fastapi-react-admin/ | Google、Bing | `https://yilecoding.github.io/fastapi-react-admin/sitemap-index.xml` |

两份都是中文在根路径、英文在 `/en/`。每页的 canonical 指向自己那份，不会被当成重复内容。

## 进度

### 百度搜索资源平台 https://ziyuan.baidu.com

- [x] 添加站点 `https://fra.wubunan.com`，HTML 标签验证（2026-11-02）
- [ ] 「资源提交 → 普通收录 → sitemap」下面点「去填写」，填 `wubunan.com` 的**主体备案号**（`X ICP备xxxxxxxx号`，不带 `-1`）。
      备案号在腾讯云控制台 https://console.cloud.tencent.com/beian 「我的备案」里，或者 https://beian.miit.gov.cn 查 `wubunan.com`
- [ ] 隔几天回来看「今日提交上限」。不是 0 了就提交：
      ```
      https://fra.wubunan.com/docs/sitemap-0.xml
      ```
      ⚠️ **不要提交 `sitemap-index.xml`**：百度不再支持索引型 sitemap，提交了也不抓
      （[百度搜索学堂：普通收录](https://ziyuan.baidu.com/college/courseinfo?id=267&page=2)）
- [ ] 「API 提交」「手动提交」的配额不是 0 的话，先手动交这几页：
      ```
      https://fra.wubunan.com/docs/
      https://fra.wubunan.com/docs/getting-started/quick-start/
      https://fra.wubunan.com/docs/guides/first-module/
      ```

配额是百度按站点质量评估的，新站是 0 很正常；填备案号有帮助，但不保证马上放开。
**配额一直是 0 也没关系**，robots.txt 已经放行 `/docs/`，百度蜘蛛自己会来，只是慢（以周计）。

### Google Search Console https://search.google.com/search-console

- [x] 添加资源「网址前缀」`https://yilecoding.github.io/fastapi-react-admin/`，HTML 文件验证（2026-11-02）
- [x] 提交 sitemap `sitemap-index.xml`（刚提交时显示「无法抓取」、上次读取时间为空，是 Google 还没去读，不是错）
- [ ] 11/4 前后回来看 sitemap 状态。还是「无法抓取」就再提交一个 `sitemap-0.xml`，仍不行截图找 Claude
- [ ] （可选）顶部搜索框输入首页地址 →「请求编入索引」，`/en/` 也来一次
- [ ] （可选）再加一个网址前缀资源 `https://fra.wubunan.com/docs/`，把给的 `googleXXXX.html` 文件名交给 Claude 放到服务器上

不要加 robots.txt：GitHub Pages 的 robots.txt 只认 `yilecoding.github.io/robots.txt`（域名根），我们的站在子路径下放了也不生效。
根上没有 robots.txt = 全部放行，现在就是最好的状态。

### Bing Webmaster https://www.bing.com/webmasters

- [ ] 登录后选「从 Google Search Console 导入」，授权即可，站点和 sitemap 一起过来，不用再验证。
      Bing 的索引也供给 DuckDuckGo、ChatGPT 搜索等

### GitHub 仓库

- [ ] Settings → General → Social preview → Edit → Upload，传 `og-preview.jpg`（Windows 桌面上；源图是 https://yilecoding.github.io/fastapi-react-admin/og.png）。
      直接传 og.png 报过「Something went really wrong」，换成去掉透明层的 JPG 再传
- [ ] （可选）仓库首页右侧 About 的 Website 改成文档站地址

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
