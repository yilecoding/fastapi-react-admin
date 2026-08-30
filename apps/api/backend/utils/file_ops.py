import dataclasses
import hashlib
import re
import uuid

from pathlib import Path

from anyio import open_file
from fastapi import UploadFile

from backend.common.enums import FileType
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.log import log
from backend.core.conf import settings
from backend.core.path_conf import PUBLIC_UPLOAD_DIR, UPLOAD_DIR
from backend.utils.timezone import timezone

# 允许留在落盘名里的字符。其余一律换成下划线 ——
# 原文件名会直接出现在 URL 里，`#` `?` `%` 空格这些会把 URL 切断或改写
_UNSAFE_CHARS = re.compile(r'[^0-9A-Za-z\u4e00-\u9fff._-]+')

# 存储名里随机后缀的长度（16 个 hex = 64 bit）
_RANDOM_LEN = 16

# 原名保留的最大长度，防止有人拿 300 字的文件名把路径顶到系统上限
_STEM_MAX = 40


@dataclasses.dataclass
class SavedFile:
    """一次落盘的结果，供 service 层写库"""

    #: 落盘文件名（**不含**目录成分），如 `报告_a1b2….pdf`
    name: str
    #: 相对落盘根目录的路径（**含**日期目录），如 `2026/08/21/报告_a1b2….pdf`。
    #: 读写磁盘一律用这个，`name` 只用于展示与排障。
    #: ⚠️ 它是**相对**路径，落在哪棵树上由 `is_public` 决定 —— 单看 path 分不出来
    path: str
    #: 落在公开子树（`/uploads` 静态挂载，不登录即可读）还是私有子树
    is_public: bool
    original_name: str
    ext: str
    content_type: str | None
    size: int
    sha256: str


def upload_root(*, public: bool) -> Path:
    """
    选落盘根目录。

    两棵**物理分开**的树：私有走 `UPLOAD_DIR`（只能通过带 JWT 的下载接口读），
    公开走 `PUBLIC_UPLOAD_DIR`（被 `/uploads` 静态挂出去，不登录也能读）。

    收成一个函数是刻意的：`upload_file` / `delete_file` / `resolve_path` 三处
    都要选根，各写一个 `if public` 迟早会漏一处 —— 而漏在**删除**那一处的表现是
    「库里删了、盘上留孤儿，日志里连 warning 都没有」（加日期目录时已经踩过一次
    同构的坑，见 delete_file 的注释）。

    :param public: 是否落公开子树
    :return:
    """
    return PUBLIC_UPLOAD_DIR if public else UPLOAD_DIR


def build_date_dir() -> str:
    """
    落盘用的日期目录，`YYYY/MM/DD`。

    分目录的理由不是「一个目录放不下」（ext4 有 dir_index，几十万文件也撑得住），
    而是三件事后补不回来的运维能力：
    1. 按周期备份 / 归档 / 过期 —— `rsync upload/2026/07`
    2. `ls` / `tar` / `find` 还能用 —— 十万个 entry 的目录谁都不想碰
    3. 换对象存储后是同一套 —— S3 的「目录」就是 key 前缀，日期前缀仍是惯例

    用**本地时区**的日期（`timezone.now()`），不是 UTC ——
    运维按日期找文件时想的是「昨天」，不是「UTC 的昨天」。
    """
    return timezone.now().strftime('%Y/%m/%d')


def strip_path(filename: str | None) -> str:
    """
    剥掉客户端文件名里的**全部路径成分**，只留最后一段。

    ⚠️ 这是安全边界，不是清理美化。`UploadFile.filename` 完全由客户端控制，
    Starlette 原样透传 Content-Disposition 里的值，**不做任何过滤**。
    直接拿它拼 `UPLOAD_DIR / filename` 就是任意文件写入：

        filename=../../../../../evil.png  →  写到仓库根，接口还返回 200

    （实测确认过。约束只是扩展名必须在白名单里，所以写不出 .py/.sh，
    但足以覆盖磁盘上任意同名图片/视频。）

    POSIX 与 Windows 客户端给的分隔符不同，两种都要剥：
    老浏览器会送完整的 `C:\\Users\\me\\a.png`。

    :param filename: 客户端给的文件名
    :return:
    """
    return (filename or '').strip().replace('\\', '/').split('/')[-1]


#: ASCII 控制字符（含裸 CR/LF），落盘名走 `build_filename` 的 `_UNSAFE_CHARS`
#: 已经连标点一起清干净了，这个只单独给 `original_name` 这类"要显示、不落盘"
#: 的展示名用——它比 `_UNSAFE_CHARS` 宽松（保留空格/标点/CJK），因为原名是给
#: 人看的，但控制字符在任何语境下都没有合法用途，反而是 issue #62 那种
#: Content-Disposition 头注入的攻击面
_CONTROL_CHARS = re.compile(r'[\x00-\x1f\x7f]')


def sanitize_display_name(filename: str) -> str:
    """清洗展示名里的控制字符

    (issue #62) `UploadFile.filename` 里出现裸换行（`\\n`，无前导 `\\r`）能
    穿过 `python-multipart` 的 header 解析原样落进 `filename`——
    `HEADER_VALUE` 状态机只在遇到 `CR` 时结束扫描，单独的 LF 不会终止。
    这类字符原样存进 `original_name` 之后，下载接口拼 Content-Disposition
    头时会被 uvicorn 的 `HEADER_VALUE_RE`（`[\\x00-\\x08\\x0a-\\x1f\\x7f]`）
    判定为非法字符，`RuntimeError('Invalid HTTP header value.')` 没有被
    `download_file` 捕获，表现是这条文件记录的下载/预览此后**永久** 500。

    在落库前挡掉，比在下发时才发现要早——已经存在的脏数据仍然只能删记录重传。

    :param filename: 已经 `strip_path()` 过的文件名
    :return:
    """
    return _CONTROL_CHARS.sub('', filename)


def get_file_ext(file: UploadFile) -> str:
    """
    取出小写扩展名

    :param file: FastAPI 上传文件对象
    :return:
    """
    name = strip_path(file.filename)
    # 原来这里写的是 `if not file_ext`，而 `'x'.split('.')[-1]` 永远非空 ——
    # 那条分支是死代码，没有扩展名的文件会一路走到「此文件格式 x 暂不支持」
    if '.' not in name.strip('.'):
        raise errors.RequestError(msg=t('error.file.unknown_type'))
    return name.rsplit('.', 1)[-1].lower()


def build_filename(file: UploadFile) -> str:
    """
    构建落盘文件名：`<清理后的原名>_<16 位随机>.<ext>`

    随机后缀有两个作用：
    1. 去重 —— 原来用 unix 时间戳，同一秒内两个同名文件会互相覆盖
    2. 不可猜 —— 原来的 `原名_10位时间戳.ext` 猜起来成本很低。
       无鉴权的 `/static/upload` 挂载已经撤掉（见 registrar.py），
       随机后缀现在是**纵深防御**而不是唯一防线

    :param file: FastAPI 上传文件对象
    :return:
    """
    ext = get_file_ext(file)
    stem = strip_path(file.filename).rsplit('.', 1)[0]
    # 原实现是 `filename.replace(f'.{ext}', ...)`，replace 是**全量**替换：
    # 'a.png.png' 会变成 'a_123_123.png'
    stem = _UNSAFE_CHARS.sub('_', stem).strip('._-')[:_STEM_MAX] or 'file'
    return f'{stem}_{uuid.uuid4().hex[:_RANDOM_LEN]}.{ext}'


def _upload_rules() -> tuple[tuple[FileType, list[str], int], ...]:
    """
    上传规则表：(分类, 扩展名白名单, 大小上限)

    做成函数而不是模块级常量 —— `settings` 会被 `sys_config` 的动态配置在运行时
    `setattr` 覆盖（见 utils/dynamic_config.py），模块级常量会把启动那一刻的值冻住。

    报错时给用户看的人话名字不在这张表里存——`FileType.value` 本身就是稳定
    标识（'image'/'document'/...），报错文案要用哪种语言的名字，现查
    `t(f'file_type.{file_type.value}')` 就是，不用在这张表里存一份中文重复。
    """
    return (
        (FileType.image, settings.UPLOAD_IMAGE_EXT_INCLUDE, settings.UPLOAD_IMAGE_SIZE_MAX),
        (FileType.document, settings.UPLOAD_DOCUMENT_EXT_INCLUDE, settings.UPLOAD_DOCUMENT_SIZE_MAX),
        (FileType.video, settings.UPLOAD_VIDEO_EXT_INCLUDE, settings.UPLOAD_VIDEO_SIZE_MAX),
        (FileType.audio, settings.UPLOAD_AUDIO_EXT_INCLUDE, settings.UPLOAD_AUDIO_SIZE_MAX),
        (FileType.archive, settings.UPLOAD_ARCHIVE_EXT_INCLUDE, settings.UPLOAD_ARCHIVE_SIZE_MAX),
    )


def classify_file_ext(file_ext: str) -> FileType:
    """
    按扩展名归类

    :param file_ext: 小写扩展名，不带点
    :return:
    """
    for file_type, includes, _ in _upload_rules():
        if file_ext in includes:
            return file_type
    return FileType.other


def upload_file_verify(file: UploadFile) -> FileType:
    """
    文件验证，返回它的分类

    ⚠️ 大小限制在这里判已经晚了 —— Starlette 先把整个 body 收完
    （超过 1 MB 落到临时文件）才轮到这个函数。所以「5 MB 上限」拦不住
    有人往这个接口灌 2 GB，真要拦得在反代 / 中间件层限 Content-Length。

    :param file: FastAPI 上传文件对象
    :return:
    """
    file_ext = get_file_ext(file)

    for file_type, includes, size_max in _upload_rules():
        if file_ext not in includes:
            continue
        # file.size 在极少数客户端下会缺失（没送 Content-Length），
        # 那种情况放过大小校验而不是拿 None 去比较
        if file.size is not None and file.size > size_max:
            raise errors.RequestError(
                msg=t(
                    'error.file.size_exceeded',
                    label=t(f'file_type.{file_type.value}'),
                    size_mb=size_max // 1024 // 1024,
                )
            )
        return file_type

    raise errors.RequestError(msg=t('error.file.unsupported_format', file_ext=file_ext))


async def upload_file(file: UploadFile, *, public: bool = False) -> SavedFile:
    """
    上传文件，边写盘边算 SHA-256

    校验和是**流式**算的：先落盘再读回来算会把大文件读两遍，
    而 `file.read()` 之后指针已经到尾，也不能重放。

    :param file: FastAPI 上传文件对象
    :param public: 落公开子树（不登录即可读），仅供富文本内联图使用；
        **是否允许公开由 service 层判定**，这里只负责按结论落盘
    :return:
    """
    filename = build_filename(file)
    # 日期目录只由服务端拼，客户端的任何输入都进不了这一段
    relative = f'{build_date_dir()}/{filename}'
    root = upload_root(public=public)
    target = root / relative

    # 兜底：build_filename 已经把路径成分剥掉了，这里再确认落点没跑出根目录。
    # 两道防线是刻意的 —— 这一条挡的是「将来有人改了 build_filename」
    if not target.resolve().is_relative_to(root.resolve()):
        log.error(f'拒绝越界的上传路径：{file.filename!r} → {target}')
        raise errors.RequestError(msg=t('error.file.invalid_filename'))

    # 日期目录按需创建。`parents=True` 是必须的 —— 每月/每年第一次上传时
    # 上两级也不存在
    target.parent.mkdir(parents=True, exist_ok=True)

    digest = hashlib.sha256()
    size = 0
    try:
        async with await open_file(target, mode='wb') as fb:
            while True:
                content = await file.read(settings.UPLOAD_READ_SIZE)
                if not content:
                    break
                digest.update(content)
                size += len(content)
                await fb.write(content)
    except Exception as e:
        log.error(f'上传文件 {filename} 失败：{e!s}')
        # 写失败会留下一个半截文件，不清掉就成了永远没人引用的垃圾
        target.unlink(missing_ok=True)
        raise errors.RequestError(msg=t('error.file.upload_failed'))
    await file.close()

    return SavedFile(
        name=filename,
        path=relative,
        is_public=public,
        original_name=sanitize_display_name(strip_path(file.filename)),
        ext=get_file_ext(file),
        content_type=file.content_type,
        # 用实际写入的字节数，而不是 file.size —— 后者来自客户端声明，可以撒谎
        size=size,
        sha256=digest.hexdigest(),
    )


def delete_file(relative_path: str, *, public: bool = False) -> None:
    """
    删除落盘文件。入参是 `sys_file.path`（**相对路径，含日期目录**）。

    ⚠️ `public` 必须跟着 `sys_file.is_public` 传 —— 两棵树里的相对路径长得一模一样，
    传错了就是在另一棵树上删一个不存在的文件：`missing_ok=True` 一声不响地成功，
    孤儿文件留在盘上，日志里什么都没有。

    ⚠️ 这里**不能**用 `strip_path()`。它会把全部路径成分剥掉，
    `2026/08/21/x.png` 变成 `x.png` → 指向 `UPLOAD_DIR/x.png` → 不存在 →
    `missing_ok=True` 一声不响地什么都没删，于是「库里删了、盘上留一堆孤儿文件」，
    日志里连 warning 都没有（加日期目录时实测确认过这条链）。

    越界防护换成 `is_relative_to`：它允许子目录、但拦得住 `../../`，
    正是这里要的语义。

    :param relative_path: 相对落盘根目录的路径
    :param public: 该文件是否落在公开子树
    :return:
    """
    value = (relative_path or '').strip()
    if not value:
        return

    root = upload_root(public=public).resolve()
    target = (upload_root(public=public) / value).resolve()
    if not target.is_relative_to(root) or target == root:
        log.error(f'拒绝越界的删除路径：{relative_path!r} → {target}')
        return

    try:
        target.unlink(missing_ok=True)
    except OSError as e:
        # 删不掉不该让接口失败 —— 库里的记录已经删了，磁盘上留个孤儿文件
        # 比「删除操作报错、用户重试、记录已经没了」要好
        log.warning(f'删除文件 {value} 失败：{e!s}')
        return

    # 顺手回收空掉的日期目录，否则跑几年会剩一堆空的 YYYY/MM/DD。
    # 只往上走到 UPLOAD_DIR 为止，且只删空目录 —— rmdir 对非空目录会抛
    # OSError，正好当成「还有别的文件，停」的信号
    parent = target.parent
    while parent != root and parent.is_relative_to(root):
        try:
            parent.rmdir()
        except OSError:
            break
        parent = parent.parent
