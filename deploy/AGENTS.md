# 生产部署

命令怎么敲看 [`deploy/README.md`](./README.md)，这一份只记**踩过的坑**——
判据和别处一样：违反了会坏，而且多数是**静默**地坏。

编排文件是 `docker-compose.prod.yml`（在仓库根，因为 `build:` 的 context 要够得着
`apps/`），入口脚本是 `deploy/prod.sh`。

## 拓扑：部署机上没有仓库

生产机上只有**三份文件**：

```
docker-compose.prod.yml     ← 仓库那份的逐字节副本
.env                        ← 本机差异全在这里，见下
.env.server                 ← 真实密钥，600 + 属主 uid 1000
```

没有源码、没有 `node_modules`、没有 pnpm。国内机器 clone 仓库 + `pnpm install`
太慢，而运行镜像根本不需要源码——这是刻意的，不是偷懒。

**所以任何部署脚本都必须能单独跑。** `deploy/prod.sh` 不 source 仓库里的任何东西、
不读 `package.json`、不假设 cwd 在仓库根；`pnpm deploy:prod*` 只是它在开发机上的
一层薄封装。

### 症状 · 前置检查一次都没跑过

前身 `scripts/deploy-prod.mjs` 写得没问题（检查 `.env.server` 存在 / 权限 600 /
没有 `CHANGE_ME` 残留），但它唯一的入口是 `pnpm deploy:prod` ——而部署机上没有
pnpm、没有 `package.json`。于是每一次真实部署，人（和 Claude）都绕过它手敲等价的
裸 `docker compose pull && up -d`，**那三条检查从上线到现在一次都没有执行过**。

失败方式是静默的：脚本存在、文档写着用它、CI 也没什么可红的，只有「它实际上从
未被调用」这件事没人看得见。

**根因不是脚本写错了，是它的运行前提和真实拓扑不匹配。** 写部署工具时先问一句：
**这个东西在只有三份文件的机器上跑得起来吗？**

## 服务器上的 compose 是手抄的

### 症状

改了仓库里的 `docker-compose.prod.yml`，部署之后服务器行为**完全不变**，
没有任何报错——因为服务器上跑的是另一份文件。

### 根因

镜像有 CI 推到 GHCR、有 `latest` 标签、有人会去 `pull`；**而编排文件没有任何
同步机制**。第一次部署时它是被拷过去再手改的（宿主机 80 被宝塔 nginx 占了要改
成 8080、`build:` 段在没有源码的机器上没意义要删掉），从那一刻起就是两份真相。

实测证据：生产机上留着一个 `docker-compose.prod.yml.bak.<时间戳>`，diff 出来正是
worker / beat 那两条健康检查的修法（`celery inspect ping` / `pgrep` → 读
`/proc/1/cmdline`）。同一个修法在仓库里改了一遍（#31 / #33），在服务器上又手改了
一遍——两边**碰巧**收敛了，靠的是人做了两次同样的事，而不是靠任何机制。

### 修法

`docker-compose.prod.yml` 是唯一一份，服务器上必须逐字节一致。本机差异全部走
compose 同级的 `.env`：

| 变量 | 干什么 |
|---|---|
| `FBA_ENV_FILE` | `.env.server` 的位置。服务器上是 `./.env.server`，不用再造仓库那套四层空目录 |
| `FBA_WEB_PORT` | web 映射到宿主机的端口。80 被占就写 8080 |
| `FBA_PULL_MIRROR` | GHCR 加速器域名，见下一节 |
| `IMAGE_OWNER` / `TAG` | fork 出去部署 / 回滚时用 |

更新那份 compose 只有一条路：`bash prod.sh sync`（从 GitHub raw 取仓库版本、
先 diff 给人看、确认后覆盖并留 `.bak`）。**手改 = 重新制造第二份真相。**

> ⚠️ `.env` 里的东西 docker compose 自己会读来做变量插值，但 shell 不会。
> `prod.sh` 因此自己也解析了一遍同一份 `.env` ——否则前置检查看到的
> `.env.server` 路径和 compose 实际挂载的那个会不一致，而这种不一致只会表现为
> 「检查通过了但容器起不来」。

## 回滚标签：文档写短 SHA，CI 推的是完整 SHA

### 症状

照文档敲 `TAG=sha-abc1234 ... pull`，报 `no such manifest`。

### 根因

CI 里写的是 `sha-${{ github.sha }}`，而 `github.sha` 是**完整 40 位** SHA。
可人手里只有短 SHA（GitHub 网页、`git log --oneline` 显示的都是它），四处文档也都
按短 SHA 写。实测：

```
docker manifest inspect ghcr.io/yilecoding/fba-api:sha-8f92000
  → no such manifest
docker manifest inspect ghcr.io/yilecoding/fba-api:sha-8f92000fd7840962457cd4a0c903c34ed01db57c
  → OK
```

回滚是**线上出事那一刻**才会跑的命令，照文档敲第一下就失败——最不该在那个时候
现查标签格式。

### 修法

CI 现在三个标签都推：`latest`（日常）、`sha-<短 SHA>`（给人敲）、
`sha-<完整 SHA>`（给机器引用）。

⚠️ **2026-09-02 之前构建的镜像只有完整 SHA 标签**，回滚到更早的版本时要用完整的。

## 镜像里带提交号，别去比摘要

CI 给镜像打了 OCI 标签 `org.opencontainers.image.revision=<完整 SHA>`，
`bash prod.sh status` 靠它直接回答「服务器上跑的是哪个提交、和 main 差多少」。

不用镜像摘要做这件事是有原因的：走加速器拉下来再 `docker tag` 回 `ghcr.io/…`
的镜像，**在本地没有 `ghcr.io` 那个名字的 RepoDigest**——摘要比对会直接失效，
而且失效的样子是「查不到」，很容易被读成「没差异」。

⚠️ 加 OCI 标签之前构建的镜像没有这个字段，`status` 会明说「无标签」，不要把它
读成「和 main 一致」。

## GHCR 在国内会被限速到几十 KB/s

不是断连、也不报错：`docker compose pull` 挂着不动，看着像卡住了，其实是在以
「一层镜像下载几个小时」的速度爬。实测（国内云节点）：`curl` 探测 `ghcr.io` 能通、
`docker pull` 却常年卡在 ~30KB/s；换成加速器同一层几秒钟拉完。

判断卡没卡看层进度条涨不涨，几分钟完全不动就该换加速器，不要傻等。

加速器**不能直接写进 compose 的镜像名**（它们只是同步了一份 `ghcr.io` 的内容，
路径前缀不一样；写进去 compose 记住的就是加速器地址了）。正确做法是拉完 retag：

```bash
docker pull ghcr.nju.edu.cn/<owner>/fba-api:latest
docker tag  ghcr.nju.edu.cn/<owner>/fba-api:latest ghcr.io/<owner>/fba-api:latest
```

这一串现在由 `prod.sh pull` 在 `.env` 里配了 `FBA_PULL_MIRROR` 时自动做掉。
加速器不是官方服务，可用性会变——卡住就换一个域名重试，原理都一样。

## `.env.server` 属主必须是 uid 1000

`Dockerfile.prod` 里进程是 `USER fba`（`useradd -u 1000 -g 1000`），而部署检查又
要求这份文件权限严格 `600`（不能有 group / other 位）。两条一起意味着**属主只能是
uid 1000**：只满足 600 但 owner 是 root 时，宿主机上看权限没问题，容器里的 fba
读不到它，pydantic-settings 加载配置那一步直接
`PermissionError: [Errno 13] Permission denied`——报错点在依赖库内部，字面上不含
「权限」两个字，很容易当成配置本身写错了去排查。

```bash
chown 1000:1000 <.env.server>
chmod 600       <.env.server>
```

`prod.sh up` 会先校验这一条（`config` / `pull` 不挂载这个文件，管不着）。

## 容器连宿主机上的数据库，不能填 127.0.0.1

SQL Server / Redis / PostgreSQL 跑在**宿主机**上但不在 docker 里（宝塔面板自带的
那些就是这种）时，容器默认桥接网络里的 `127.0.0.1` 是**容器自己的**回环地址。

`.env.server` 里的 `DATABASE_HOST` / `REDIS_HOST` 要填宿主机在 docker 网桥上的地址
（一般 `172.17.0.1`，`ip addr show docker0` 能查），或者给服务加
`extra_hosts: ["host.docker.internal:host-gateway"]` 再填 `host.docker.internal`。

表现是 API 容器起来了、健康检查一直连不上数据库——最常见的一个坑。

## docker daemon 不读 shell 的 http_proxy

走本地构建那条路（`prod.sh build`）时，`curl` 拿得到 `ghcr.io`、`docker build`
却 `i/o timeout`，报错指向 Dockerfile 的 `FROM` 行，看起来像镜像名写错了。
要在 WSL / 代理环境里构建，给 daemon 单独配一次：

```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/http-proxy.conf <<'EOF'
[Service]
Environment="HTTP_PROXY=http://<代理>:<端口>"
Environment="HTTPS_PROXY=http://<代理>:<端口>"
Environment="NO_PROXY=localhost,127.0.0.1"
EOF
sudo systemctl daemon-reload && sudo systemctl restart docker
```

## 自动部署：刻意没做

CI 构建完镜像**不会**自动同步到服务器，同步是人明确决定的动作。理由是接自动部署
要把 SSH 私钥或面板密钥放进 GitHub Actions secrets，对一个人维护的项目来说，
这层暴露面换来的便利不成正比。

想减少手动同步的负担，优先选**不需要往 CI 里塞凭据**的那一侧：`prod.sh status`
是拉取式的（服务器主动问 GitHub「main 是哪个提交」），挂进 cron 就能得到
「落后了」的提醒，而不用把服务器的钥匙交出去。真要接自动部署再重新评估。
