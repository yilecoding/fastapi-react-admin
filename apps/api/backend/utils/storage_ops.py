"""
存储抽象：把「内置本地存储」和 `sys_storage` 里配的本地 / S3 兼容存储收成同一个形状。

底层是 Apache OpenDAL（`opendal`），一套 `AsyncOperator` 接口同时覆盖本地盘和 S3 协议。
几条只有实测才知道的约束（opendal 0.47.12，`moto` 模拟的 S3 上跑过）：

- 🔴 **异常类是平的**：0.47 起 `NotFound` / `PermissionDenied` … 各自直接继承 `Exception`，
  `except opendal.exceptions.Error` **接不住** `NotFound`（0.46 还接得住）。要逐个点名
- 🔴 **流式读取的报错是裸 `OSError`**：`await op.open(不存在, 'rb')` 本身成功，第一次 `read()`
  才抛 `OSError('NotFound ...')`。所以读之前先 `stat`
- ⚠️ `AsyncFile.read(n)` 会**短读**（要 1 MiB 回来十几 KB），只有返回 `b''` 才是读完了
- 🔴 构造 S3 operator **不联网**，但默认会去捡运行环境的凭据（`AWS_*` 环境变量、`~/.aws`、
  云主机的 169.254.169.254）。用户在界面上配的存储**必须**关掉这两条（见 `_s3_operator`）
"""

import asyncio
import dataclasses
import ipaddress
import mimetypes

from collections.abc import AsyncIterator
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

import anyio
import opendal

from backend.common.log import log

if TYPE_CHECKING:
    from backend.app.admin.model import Storage

#: 子树目录名。每个 `sys_storage` 下面固定这两棵，和内置存储的 UPLOAD_DIR / PUBLIC_UPLOAD_DIR 对应
_PRIVATE_DIR = 'private'
_PUBLIC_DIR = 'public'

#: 这些云厂商的 S3 兼容接口**只认虚拟主机风格**（`<bucket>.<endpoint>`）：
#: 阿里 OSS 对路径风格回 403 `SecondLevelDomainForbidden`，腾讯 COS 2024 年后建的桶回
#: `PathStyleDomainForbidden`。OpenDAL 默认是路径风格，所以 `addressing=auto` 时按域名判
_VIRTUAL_HOST_DOMAINS = ('aliyuncs.com', 'myqcloud.com', 'qiniucs.com', 'myhuaweicloud.com', 'volces.com')

#: 流式读取一次要多少。`read(n)` 会短读，这只是上限
READ_CHUNK = 1024 * 1024

#: `mimetypes` 在部分系统上不认识的图片格式
_IMAGE_MIME = {'avif': 'image/avif', 'webp': 'image/webp', 'ico': 'image/x-icon', 'svg': 'image/svg+xml'}


def content_type_from_key(key: str) -> str:
    """
    按扩展名推 MIME 类型。

    🔴 公开件（`/uploads`、S3 对象的 Content-Type、预签名的 response-content-type）**只认这个**，
    不认客户端 multipart 里声明的类型：`UploadFile.content_type` 完全由客户端控制，
    `x.png` 配一个 `text/html` 的声明就能让无鉴权的 `/uploads/…/x.png` 以 HTML 下发
    （原来的 StaticFiles 挂载是按扩展名猜的，换成路由时漏了这一层 —— 代码审查抓到的）
    """
    ext = key.rsplit('.', 1)[-1].lower() if '.' in key else ''
    return _IMAGE_MIME.get(ext) or mimetypes.guess_type(key)[0] or 'application/octet-stream'


class StorageError(Exception):
    """存储层的失败，`reason` 是稳定标识（给 i18n 用），**不含**上游响应体"""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclasses.dataclass(frozen=True)
class StorageTarget:
    """一个存储里的一棵子树（私有 / 公开），读写删都对着它做"""

    #: `sys_storage.id`；None = 内置本地存储
    storage_id: int | None
    #: `local` / `s3`
    kind: str
    public: bool
    op: opendal.AsyncOperator
    #: 本地类存储的物理根目录。下载走 `FileResponse`（自带 Range / ETag）、删除后回收空目录都要它
    local_root: Path | None = None
    #: 公开件的外部访问前缀（CDN / 公开桶），只对 public 子树有意义
    public_base_url: str | None = None

    @property
    def can_presign(self) -> bool:
        # 🔴 OpenDAL 的 fs 后端不支持预签名（`capability().presign == False`，调用抛 Unsupported）
        return self.kind == 's3'


# ─── key ────────────────────────────────────────────────────────────────────


def check_key(key: str) -> str:
    """
    校验对象 key（`sys_file.path`）。

    key 只由服务端拼（`build_date_dir()` + `build_filename()`），这里是第二道防线：
    一旦哪天有人往库里写了 `../`，读 / 删就成了任意文件读写。OpenDAL 的 fs 后端自己也会拒绝
    逃出 root 的路径（实测报 NotFound「path escapes the configured root」），但 S3 不会 ——
    `a/../../b` 在 S3 上就是一个合法的、名字奇怪的对象

    :param key: 相对子树根的 key
    :return:
    """
    value = (key or '').strip()
    if not value or value.startswith('/') or '\\' in value or any(ord(c) < 0x20 or ord(c) == 0x7F for c in value):
        raise StorageError('invalid_key')
    for part in value.split('/'):
        # 「只由点和空白组成」的段一律拒：Windows 会剥掉段尾的点和空格，`.. ` 落盘后就变回 `..`
        if not part or not part.strip(' .'):
            raise StorageError('invalid_key')
    return value


# ─── endpoint ───────────────────────────────────────────────────────────────


def use_virtual_host(endpoint: str | None, addressing: str) -> bool:
    """按 `addressing`（auto / virtual / path）决定是否用虚拟主机风格"""
    if addressing == 'virtual':
        return True
    if addressing == 'path':
        return False
    host = (urlsplit(endpoint or '').hostname or '').lower()
    return any(host == d or host.endswith(f'.{d}') for d in _VIRTUAL_HOST_DOMAINS)


async def check_endpoint(endpoint: str) -> str:
    """
    校验 S3 端点，挡住 SSRF 里最危险的那一类。

    🔴 「测试连接」会从服务器发请求到这个地址，而 OpenDAL 的报错里带着上游响应。
    配成 `http://169.254.169.254/...` 就是在读云主机的元数据（含临时凭据）——
    Label Studio（CVE-2025-25297）、Coolify（CVE-2026-42147）都栽在这里。

    ⚠️ **刻意不拦私网地址**：MinIO 跑在内网（`http://minio:9000`、`10.x`）是这个功能
    最主要的用法，拦了就没法用。拦的是链路本地（含元数据地址）、未指定地址和组播 ——
    这几类没有任何合法的存储会落在上面

    :param endpoint: 端点 URL
    :return:
    """
    value = (endpoint or '').strip().rstrip('/')
    parts = urlsplit(value)
    try:
        # `.port` 对 `:9000x` / `:99999` 抛 ValueError，要和「协议 / 主机不对」一样翻成 invalid_endpoint，不能漏成 500
        port = parts.port
    except ValueError as e:
        raise StorageError('invalid_endpoint') from e
    if parts.scheme not in ('http', 'https') or not parts.hostname:
        raise StorageError('invalid_endpoint')
    if parts.username or parts.password or parts.query or parts.fragment:
        raise StorageError('invalid_endpoint')
    try:
        # 🔴 走事件循环的 getaddrinfo（线程池）：同步的 `socket.getaddrinfo` 会把整个 worker 冻住，
        # 解析不了的主机名在本机实测卡 10 秒，期间所有人的所有请求都停（代码审查抓到的）
        loop = asyncio.get_running_loop()
        infos = await loop.getaddrinfo(parts.hostname, port or (443 if parts.scheme == 'https' else 80))
    except (OSError, UnicodeError):
        # 解析不了不是 SSRF，是配错了 —— 留给「测试连接」报「连不上」
        return value
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split('%')[0])
        mapped = getattr(ip, 'ipv4_mapped', None)
        if mapped is not None:
            ip = mapped
        if ip.is_link_local or ip.is_unspecified or ip.is_multicast or str(ip) == 'fd00:ec2::254':
            raise StorageError('forbidden_endpoint')
    return value


# ─── operator ───────────────────────────────────────────────────────────────

#: 本地 operator 按根目录缓存。按**路径字符串**做键而不是常驻单例 —— 测试会把 UPLOAD_DIR 顶到 tmp
_FS_OPERATORS: dict[str, opendal.AsyncOperator] = {}

#: 表里的存储按 `(id, updated_time, public)` 缓存。
#:
#: 🔴 **不能只按 id 缓存**：多副本部署时 A 机改了配置，B 机进程里还是旧 operator。
#: 这里每次都是拿**刚从库里读出来的那一行**来取 operator，配置一变 `updated_time` 就变、
#: 自然建新的 —— 不靠广播，也就没有「消息丢了」这回事（ContiNew 只在本进程卸载重注册，
#: 多副本下要重启才生效）
_ROW_OPERATORS: dict[tuple, opendal.AsyncOperator] = {}


def _fs_operator(root: Path) -> opendal.AsyncOperator:
    key = str(root)
    op = _FS_OPERATORS.get(key)
    if op is None:
        root.mkdir(parents=True, exist_ok=True)
        op = opendal.AsyncOperator('fs', root=key)
        _FS_OPERATORS[key] = op
    return op


def _s3_operator(storage: 'Storage', secret_key: str, *, public: bool) -> opendal.AsyncOperator:
    prefix = '/'.join(p for p in ((storage.root or '').strip('/'), _PUBLIC_DIR if public else _PRIVATE_DIR) if p)
    kwargs = {
        'bucket': storage.bucket or '',
        'endpoint': (storage.endpoint or '').rstrip('/'),
        # OpenDAL 不填 region 会去探测；MinIO 之类不关心 region 的填什么都行
        'region': storage.region or 'us-east-1',
        'root': f'/{prefix}',
        'access_key_id': storage.access_key or '',
        'secret_access_key': secret_key,
        # 🔴 这两条必须写，而且**必须是字符串**（传 True 抛 TypeError）：
        # - 不写 `disable_config_load`：AK 为空时会读 AWS_ACCESS_KEY_ID 等环境变量 —— 实测预签名地址里
        #   出现的是环境里那把 key（拿服务器自己的身份去访问用户指定的桶）。配了 AK 时用配的那把
        # - 只写它不写 `disable_ec2_metadata`：凭据为空时每次调用先去连 169.254.169.254，
        #   **卡 30 秒**再报一句看不出原因的 `signing http request` 失败
        'disable_config_load': 'true',
        'disable_ec2_metadata': 'true',
    }
    if use_virtual_host(storage.endpoint, storage.addressing):
        kwargs['enable_virtual_host_style'] = 'true'
    return opendal.AsyncOperator('s3', **kwargs)


def local_row_root(storage: 'Storage', *, public: bool) -> Path:
    """表里那种本地存储的子树根目录"""
    return Path(storage.root) / (_PUBLIC_DIR if public else _PRIVATE_DIR)


def builtin_target(*, public: bool) -> StorageTarget:
    """内置本地存储（`storage_id IS NULL`）"""
    # 在调用时才去 file_ops 取根 —— 选根只有 `upload_root()` 一处（它的注释里写了为什么）
    from backend.utils.file_ops import upload_root

    root = upload_root(public=public)
    return StorageTarget(storage_id=None, kind='local', public=public, op=_fs_operator(root), local_root=root)


def row_target(storage: 'Storage', *, public: bool, secret_key: str | None = None) -> StorageTarget:
    """
    表里一行存储的某棵子树

    :param storage: 刚从库里读出来的存储
    :param public: 公开子树还是私有子树
    :param secret_key: S3 的明文 SecretKey（调用方解密好再传，这一层不碰加密密钥）
    :return:
    """
    if storage.type == 'local':
        root = local_row_root(storage, public=public)
        return StorageTarget(storage_id=storage.id, kind='local', public=public, op=_fs_operator(root), local_root=root)

    version = storage.updated_time.isoformat() if storage.updated_time else ''
    cache_key = (storage.id, version, public)
    op = _ROW_OPERATORS.get(cache_key)
    if op is None:
        # 同一个存储的旧版本 operator 顺手清掉，不然每改一次配置就多留一个
        for stale in [k for k in _ROW_OPERATORS if k[0] == storage.id and k[2] == public]:
            _ROW_OPERATORS.pop(stale, None)
        op = _s3_operator(storage, secret_key or '', public=public)
        _ROW_OPERATORS[cache_key] = op
    base = (storage.public_base_url or '').rstrip('/') or None
    return StorageTarget(
        storage_id=storage.id, kind='s3', public=public, op=op, public_base_url=base if public else None
    )


# ─── 读写删 ──────────────────────────────────────────────────────────────────


def _reason(e: Exception) -> str:
    """把 OpenDAL 的异常归成稳定标识。🔴 原始消息**只进日志**：里面带着上游响应体（SSRF 回显面）"""
    text = str(e)
    if isinstance(e, opendal.exceptions.NotFound):
        return 'not_found'
    if isinstance(e, opendal.exceptions.PermissionDenied):
        return 'permission_denied'
    if isinstance(e, opendal.exceptions.ConfigInvalid):
        # 桶不存在时 S3 回 NoSuchBucket，OpenDAL 把它归成 ConfigInvalid（RustFS 上实测）——
        # 对用户来说那是「桶不存在」，不是「配置不合法」
        return 'not_found' if 'NoSuchBucket' in text else 'config_invalid'
    if 'NotFound' in text:
        return 'not_found'
    if 'connect' in text.lower() or 'dns' in text.lower() or 'timed out' in text.lower():
        return 'unreachable'
    return 'unexpected'


async def write_stream(
    target: StorageTarget, key: str, chunks: AsyncIterator[bytes], *, content_type: str | None = None
) -> None:
    """
    流式写入。S3 上 OpenDAL 的 writer 会自己攒成 ≥5 MiB 的分片走 multipart（实测 12 MiB → 3 片）

    :param target: 目标子树
    :param key: 对象 key
    :param chunks: 字节块
    :param content_type: MIME 类型
    :return:
    """
    key = check_key(key)
    options = {'content_type': content_type} if content_type and target.kind == 's3' else {}
    try:
        async with await target.op.open(key, 'wb', **options) as writer:
            async for chunk in chunks:
                await writer.write(chunk)
    except StorageError:
        raise
    except Exception as e:
        log.error(f'写入存储 {target.storage_id or "builtin"}:{key} 失败：{e!s}')
        raise StorageError(_reason(e)) from e


async def stat_size(target: StorageTarget, key: str) -> int:
    """对象大小。不存在抛 `StorageError('not_found')`"""
    key = check_key(key)
    try:
        meta = await target.op.stat(key)
    except Exception as e:
        reason = _reason(e)
        if reason != 'not_found':
            log.error(f'读取存储 {target.storage_id or "builtin"}:{key} 的元数据失败：{e!s}')
        raise StorageError(reason) from e
    return int(meta.content_length)


async def iter_read(target: StorageTarget, key: str) -> AsyncIterator[bytes]:
    """
    流式读取。**调用前先 `stat_size`**：这里一旦开始吐字节，响应头已经发出去了，
    中途失败只能截断连接，没法再改成 404

    :param target: 目标子树
    :param key: 对象 key
    :return:
    """
    key = check_key(key)
    async with await target.op.open(key, 'rb') as reader:
        while True:
            chunk = await reader.read(READ_CHUNK)
            # ⚠️ 短读是常态，只有空串才是读完
            if not chunk:
                break
            yield bytes(chunk)


async def delete_object(target: StorageTarget, key: str) -> None:
    """
    删除对象。失败只记日志不抛 —— 「库里删了、存储里留个孤儿」比「删除报错、用户重试、
    记录已经没了」要好（同 `file_ops.delete_file`）

    本地类存储走 `file_ops.delete_local_file`：它会顺手回收空掉的日期目录，OpenDAL 的 delete 不会

    :param target: 目标子树
    :param key: 对象 key
    :return:
    """
    if target.local_root is not None:
        from backend.utils.file_ops import delete_local_file

        # unlink + rmdir 放线程里：表里的本地存储多半是 NAS 挂载，挂死时别把事件循环带走
        await anyio.to_thread.run_sync(delete_local_file, target.local_root, key)
        return
    try:
        await target.op.delete(check_key(key))
    except Exception as e:
        log.warning(f'删除存储 {target.storage_id}:{key} 失败：{e!s}')


async def presign_read(
    target: StorageTarget, key: str, *, expire: int, content_disposition: str, content_type: str | None
) -> str:
    """
    预签名下载地址（只有 S3 类存储有）。文件名靠 `response-content-disposition` 带过去

    :param target: 目标子树
    :param key: 对象 key
    :param expire: 有效期（秒）
    :param content_disposition: 下发的 Content-Disposition
    :param content_type: 下发的 Content-Type
    :return:
    """
    try:
        req = await target.op.presign_read(
            check_key(key), expire, content_disposition=content_disposition, content_type=content_type
        )
    except StorageError:
        raise
    except Exception as e:
        log.error(f'签发存储 {target.storage_id}:{key} 的下载地址失败：{e!s}')
        raise StorageError(_reason(e)) from e
    return req.url


async def probe(target: StorageTarget) -> None:
    """
    测试连接：写一个探测对象 → 读回比对 → 删掉。三步都成才算通

    只做 `op.check()`（列一下根）不够：只读权限的 key 能过 check，上传时才 403

    :param target: 目标子树
    :return:
    """
    key = '.fra-probe'
    payload = b'fastapi-react-admin storage probe'
    try:
        await target.op.write(key, payload)
        got = await target.op.read(key)
        await target.op.delete(key)
    except Exception as e:
        log.warning(f'存储 {target.storage_id} 测试连接失败：{e!s}')
        raise StorageError(_reason(e)) from e
    if bytes(got) != payload:
        raise StorageError('unexpected')
