"""附件 → 纯文本，给模型读（审批 AI 预审 · 以后的自动填单）。

只管「读不读得出来」，不管业务：读得出来给文本，读不出来给一句**原因**（`note`），从不抛异常 ——
调用方要的是「这份附件模型能不能参考」，一份附件坏了不该拖垮整次预审。

🔴 读出来的东西是**不可信输入**（申请人上传的文件里可以写「忽略以上指令」），调用方只能把它放进 user 消息、
JSON 编码，不能拼进 system。这一层不做任何过滤 —— 过滤挡不住注入，隔离才挡得住。

支持：txt / md / csv / json · xlsx（`excel_ops.xlsx_text`）· docx（自己读 zip 里的 XML，不加依赖）· pdf（pypdf）。
扫描件 / 图片读不出文字，要视觉模型，这里只说明「没有可读文字」。
"""

import io
import zipfile

from dataclasses import dataclass
from xml.etree import ElementTree

from backend.core.conf import settings

#: 纯文本类，直接解码
_PLAIN = {'txt', 'md', 'csv', 'json', 'log', 'xml'}
#: PDF 最多读多少页：报销单、合同读前几页就够判断，几百页的扫描件读完要几十秒
PDF_MAX_PAGES = 20
_W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'


@dataclass(frozen=True)
class DocText:
    text: str | None
    #: 读不出来 / 只读了一部分的原因（给模型看，也落审计）
    note: str | None = None
    truncated: bool = False


def extract_text(raw: bytes, ext: str, *, max_chars: int) -> DocText:
    """`ext` 是小写、不带点的扩展名（`sys_file.ext`）。CPU 活，调用方放线程里跑"""
    ext = ext.lower().lstrip('.')
    try:
        if ext in _PLAIN:
            return _cut(_decode(raw), max_chars)
        if ext == 'xlsx':
            from backend.utils.excel_ops import xlsx_text

            text, truncated = xlsx_text(raw, max_chars=max_chars)
            return _cut(text, max_chars, truncated=truncated)
        if ext == 'docx':
            return _cut(_docx(raw), max_chars)
        if ext == 'pdf':
            return _pdf(raw, max_chars)
    except Exception as e:  # 坏文件 / 解压炸弹 / 加密文档：都是「这份读不了」，不是「预审失败」
        return DocText(None, note=f'读不出来（{type(e).__name__}）')
    return DocText(None, note=f'不支持读取 .{ext} 文件的内容')


def _cut(text: str, max_chars: int, *, truncated: bool = False) -> DocText:
    text = text.strip()
    if not text:
        return DocText(None, note='没有可读的文字')
    if len(text) > max_chars or truncated:
        return DocText(text[:max_chars], note=f'只读了前 {max_chars} 个字', truncated=True)
    return DocText(text)


def _decode(raw: bytes) -> str:
    # 国内的 csv / txt 很多是 GBK：utf-8 解不开再按 gb18030（GBK 的超集）
    try:
        return raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        return raw.decode('gb18030', errors='replace')


def _docx(raw: bytes) -> str:
    """段落按正文顺序拼，表格一行一行（格之间 Tab）。docx 也是 zip：先按 xlsx 那条解压炸弹规则看一眼"""
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        entries = zf.infolist()
        if sum(i.file_size for i in entries) > settings.TABLE_IMPORT_UNCOMPRESSED_MAX:
            raise ValueError('uncompressed size over limit')
        if len(entries) > settings.TABLE_IMPORT_MAX_ENTRIES:
            raise ValueError('too many entries')
        root = ElementTree.fromstring(zf.read('word/document.xml'))  # 本地 zip 里的 XML；expat 自带实体放大防护
    body = root.find(f'{_W}body')
    lines: list[str] = []
    for block in body if body is not None else []:
        if block.tag == f'{_W}p':
            lines.append(''.join(t.text or '' for t in block.iter(f'{_W}t')))
        elif block.tag == f'{_W}tbl':
            for row in block.iter(f'{_W}tr'):
                cells = [''.join(t.text or '' for t in cell.iter(f'{_W}t')) for cell in row.iter(f'{_W}tc')]
                lines.append('\t'.join(cells))
    return '\n'.join(line for line in lines if line.strip())


def _pdf(raw: bytes, max_chars: int) -> DocText:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(raw))
    if reader.is_encrypted and not reader.decrypt(''):
        return DocText(None, note='PDF 加了密码，读不了')
    pages = reader.pages
    parts: list[str] = []
    size = 0
    for page in list(pages)[:PDF_MAX_PAGES]:
        text = page.extract_text() or ''
        parts.append(text)
        size += len(text)
        if size > max_chars:
            break
    text = '\n'.join(parts).strip()
    if not text:
        return DocText(None, note='没有可读的文字（多半是扫描件或图片）')
    result = _cut(text, max_chars)
    if len(pages) > PDF_MAX_PAGES and not result.truncated:
        return DocText(result.text, note=f'共 {len(pages)} 页，只读了前 {PDF_MAX_PAGES} 页', truncated=True)
    return result
