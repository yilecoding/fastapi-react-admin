---
title: 文件与存储
description: 带在线预览的文件管理器，本地盘与 S3 兼容存储走同一套 Apache OpenDAL 接口；支持秒传、分片并发上传，页面刷新后可以断点续传。
sidebar:
  order: 5
---

文件模块是一个文件管理器：宫格或列表视图、左侧分类栏、浏览器内预览。底下的存储层用 [Apache OpenDAL](https://opendal.apache.org/) 把本地盘和任意 S3 兼容的桶收成同一套接口。所有上传都进同一个全局队列。浏览器先给文件算 SHA-256，服务端已经有同一个文件就不再传。不小于 16 MiB 的文件按 8 MiB 一片、3 片并发上传，刷新页面后可以接着传。可以在[在线演示](https://fra.wubunan.com/sign-in)（`admin` / `123456`）里直接试。

## 能预览哪些格式？

PDF、Word（`docx`/`doc`/`odt`）、表格（`xlsx`/`xls`/`csv`）、`pptx`、图片、文本与代码、压缩包（`zip`/`rar`/`7z`/`tar`/`gz`）、音视频。渲染器来自 `@file-viewer`（Apache-2.0）。页面带着用户的 token 取回字节，再交给预览器，所以不存在无鉴权的直链。有两道门槛是仓库里实测后定下的：

- **图片按像素数拦，不按字节数拦。** 一张 4 亿像素的 PNG 交给预览器，主线程卡了 5.2 秒。所以超过 1.5 亿像素的图只给下载，判断时只读文件头。
- 超过 100 MB 的音视频只给下载：要先把整个文件下载下来才能播放。

宫格里的缩略图直接用原图，只对 1 MB 以内、非 SVG 的图片生效，并且懒加载。

## 文件可以存在哪？

- **内置本地存储**：`sys_file.storage_id = NULL` 的文件，落在 `apps/api/backend/upload/`。它刻意不放在 `backend/static/` 下，因为那个目录是无鉴权挂出去的。
- **自己加的存储**：在「存储管理」页新建，类型是 `local` 或 `s3`。页面上可以「测试连接」（写入、读回、删除一个探测对象），也可以「设为默认」。
- 每个存储下面固定有**私有**、**公开**两棵子树。公开件只收图片，专给富文本正文里的内联图用，因为 `<img src>` 带不上鉴权头。它经 `/uploads/{key}` 无鉴权读取；配了 `public_base_url` 的话，也可以走 CDN。

切换默认存储只影响新上传。读取、删除、签地址一律按文件记录上的那个存储。存储下还有文件就不能删，回收站里的也算。S3 的 SecretKey 用 `STORAGE_ENCRYPT_SECRET_KEY` 加密后入库；这个密钥留空时，保存 S3 存储会直接报错，不会退而存明文。

每个 OpenDAL 的 S3 operator 都带着下面两个选项，缺一不可：

```python
'disable_config_load': 'true',   # 不写：AK 为空时会拿服务器自己的 AWS_ACCESS_KEY_ID 去签名
'disable_ec2_metadata': 'true',  # 不写：凭据为空时每次调用先去连 169.254.169.254，卡约 30 秒
```

保存存储时，端点解析到链路本地、未指定或组播地址（比如 `169.254.169.254`）的会被拒绝。「测试连接」是从服务器发请求的，不挡的话就是一个 SSRF 入口。内网地址刻意不挡：MinIO 跑在内网正是最常见的用法。

:::note
寻址方式选 `auto` 时，阿里云 OSS、腾讯云 COS、七牛、华为云、火山引擎的端点会自动切到虚拟主机风格。这条规则来自各家文档，还没有用这几家的真实账号测过。S3 相关的测试跑在 moto 和 RustFS 上。
:::

## 下载怎么走？

私有文件经 `GET /api/v1/sys/files/{id}/download` 读取，要带 token，由后端流式转发。存在某个存储上的文件，点「下载」时先调 `GET /api/v1/sys/files/{id}/link`。S3 上返回一个预签名地址，有效期 `STORAGE_PRESIGN_EXPIRE_SECONDS`（默认 300 秒），浏览器拿它直接从桶里下载。本地类存储返回 `url: null`，因为 OpenDAL 的 fs 后端不支持预签名。遇到这种情况，以及内置存储上的文件，前端会带着 token 取 `/download`，再存成 Blob。预览一律走后端流式代理，所以**桶上不用配 CORS**。

满足以下任一条件就能读到文件：文件是公开的、是自己传的、持有 `sys:file:list`、或者业务模块（通知公告、审批）判定他有权看。其余一律返回 **404** 而不是 403，免得等于告诉对方这个 ID 存在。只校验「已登录」是不够的：雪花 ID 会出现在 URL、日志、审批单的表单数据里。

## 秒传是怎么判断的？

浏览器用 `hash-wasm` 分块增量计算 SHA-256。没用 `crypto.subtle`：它要把整个文件读进内存，而且在局域网的纯 http 地址下是 `undefined`。算完调 `GET /api/v1/sys/files/check`：同一个人、同名、同内容、同一个存储里传过，就一个字节都不传，直接复用旧记录。文件名是 key 的一部分，所以改名后再传会存成另一条记录。回收站里的文件不参与复用。

## 大文件怎么传？

小于阈值的文件一个 `POST /upload` 传完。大的走下面五个接口，全部要求 `sys:file:upload`：

| 步骤 | 接口 |
|---|---|
| 开始（和 `/upload` 同一份校验：扩展名、大小上限、公开件只收图片） | `POST /api/v1/sys/files/multipart` |
| 传第 *n* 片（裸字节，3 片并发） | `PUT /api/v1/sys/files/multipart/{upload_id}/{n}` |
| 查服务端已有哪些片 | `GET /api/v1/sys/files/multipart/{upload_id}` |
| 合并、算哈希、落库（再校验一遍） | `POST /api/v1/sys/files/multipart/{upload_id}/complete` |
| 取消并删掉已传的片 | `DELETE /api/v1/sys/files/multipart/{upload_id}` |

上传会话存在 Redis 里，24 小时没有动静就过期，每传一片续一次。分片落在目标存储的 `_multipart/{upload_id}/` 下，所以哪台后端接到哪一片都行。这一点实测过：两个 uvicorn 进程交替接分片，存储用的是 RustFS。服务端边收边数字节，某一片超过分片大小就当场断开连接。两个同时到达的 `complete` 靠 Redis 锁只放一个去合并，另一个返回 409。每天 04:00 的 `maintenance.purge_stale_multipart` 会清掉过期会话留下的分片。

阈值和每片大小（默认 16 MiB / 8 MiB）在「参数配置 → 文件 → 文件上传」里改，经 `GET /api/v1/sys/files/upload-policy` 下发给浏览器。阈值上限是 99 MiB，因为单请求那条路要受 `apps/web/nginx.conf` 里 `client_max_body_size 100m` 的约束。

:::caution
这不是 S3 原生的 multipart：OpenDAL 没有暴露 UploadPart / ListParts。`complete` 要把各片读回来、写成最终对象，对象存储上的字节等于读写了两遍。单个文件仍受分类大小上限约束（默认图片 5 MB、文档 50 MB、音视频 20 MB、压缩包 100 MB，对应 `UPLOAD_*_SIZE_MAX`）。
:::

## 刷新页面后怎么续传？

刷新之后浏览器里的 `File` 对象就没了，只能让用户重新选一次文件。`resume.ts` 在 `localStorage` 里记着「指纹（文件名 + 大小 + 修改时间）→ upload_id」。上传浮窗挂载时用 `GET …/multipart/{id}` 逐个核对，已过期的丢掉，还活着的显示成「N 项上传未完成」，带「继续」和「放弃」两个按钮。重新选的文件指纹对不上，就弹 toast 报错，什么都不传。在文件页里直接重新选同一个文件，也会自动续上。

实测（Playwright，上传限速 3 MiB/s）：40 MiB 的文件共 5 片，传完第 1–3 片时刷新，点「继续」选回同一个文件，结果**只 PUT 了第 4、5 片**再加一次 `complete`，SHA-256 与原文件一致。「取消」会删掉服务端会话；上传失败则保留会话，点「重试」从断点接着传。

## 上传浮窗是什么？

上传队列是全局的（一个 zustand store），挂在应用外壳上、页签之外。关掉文件页签、切到别的页面，上传都不受影响。右下角浮窗显示「正在上传 N 项内容」、剩余时间和每个文件的状态，可以取消或重试。浮窗折叠时有文件传完，会弹一条 toast。文件之间按顺序逐个上传，同一个文件的分片并发上传。

## 怎么给业务记录挂附件？

```tsx
<FileAttachments targetType={NOTICE_ATTACHMENT_TARGET} targetId={notice.id} />
```

任何页面传入业务类型和 ID 就能嵌入附件面板，关联存在 `sys_file_relation` 里。「移除」只解开关联，不删文件。挂载是幂等的。后端不校验 `target_type`，拼错不会报错、只会读到空列表，所以要用常量。只供查看的位置要传 `readOnly`。

## 删除文件会发生什么？

文件进回收站：打上删除标记、解开附件关联，存储里的对象原样保留。回收站里的文件一律读不到，所有读取路径都返回 404。「还原」会把这一次删除解开的关联挂回去；之前手动移除的那些不会被挂回。每天 03:45 的 `maintenance.purge_recycled_files` 彻底删除超过 `FILE_RECYCLE_DAYS` 天的文件（默认 30 天，设为 `0` 即关闭回收站）。

## 本地怎么试 S3？

```bash
docker compose -f docker-compose.dev.yml --profile s3 up -d rustfs   # S3 接口在 :9100
```

先在 `apps/api/backend/.env` 里配好 `STORAGE_ENCRYPT_SECRET_KEY`（`openssl rand -hex 32`）。再到「存储管理」新建一个存储：端点填 `http://127.0.0.1:9100`，桶自己建一个，AK/SK 见 `docker-compose.dev.yml`，寻址方式选「路径风格」（没配 `server-domains` 的 RustFS 只认路径风格）。

## 代码在哪

- [`apps/api/backend/utils/storage_ops.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/utils/storage_ops.py)：OpenDAL operator、预签名、端点校验
- [`apps/api/backend/app/admin/service/multipart_service.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/admin/service/multipart_service.py)：分片上传会话
- [`apps/api/backend/app/admin/api/v1/sys/file.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/admin/api/v1/sys/file.py)：文件接口
- [`packages/platform/src/upload/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/packages/platform/src/upload)：哈希、队列、分片、续传
- [`packages/platform/src/pages/file/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/packages/platform/src/pages/file)：文件管理器、预览弹窗、附件面板
- [`packages/platform/src/pages/file/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/pages/file/AGENTS.md)：设计取舍与实测记录

## 怎么测的

- 后端 pytest 打真实数据库和 Redis：`test_file.py`（33 条）、`test_multipart.py`（26 条用例）、`test_recycle.py`（12 条），另有 `test_storage.py`、`test_upload_policy_config.py`、`test_file_access.py`。`test_storage.py` 默认跑进程内的 moto S3；设置 `STORAGE_TEST_S3_ENDPOINT` 就改打真实的 S3 服务，会多跑几条 moto 验不了的用例（比如 SecretKey 填错）。
- 变异检验：故意把分片上传改坏 11 处（分片接口漏权限、不加锁、超长不断开……）、把回收站改坏 6 处，每一处都有测试变红。
- 前端：`packages/platform/src/upload/` 下 20 条 Vitest 用例，以及 Playwright 的 `file-upload.spec.ts`、`file-preview.spec.ts`。
