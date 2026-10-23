"""附件 → 纯文本（`utils/doc_text.py`）：每种格式读得出来，读不出来的给原因、从不抛异常。

AI 预审把这段文字喂给模型（#111 第 2 条）。会静默出错的两个方向：
- 读不出来却**什么都不说**（返回空串）—— 模型会以为附件就是空的，进而下「缺少附件」这种错的结论
- 一份坏文件**抛异常** —— 整次预审失败，而真正坏的只是那一份附件
"""

import io
import zipfile

import pytest

from openpyxl import Workbook

from backend.utils import doc_text
from backend.utils.doc_text import extract_text


def _pdf(text: str | None) -> bytes:
    """手写一个一页的 PDF；`text=None` 就是没有文字层（扫描件就是这样：只有图，没有字）"""
    content = f'BT /F1 12 Tf 20 100 Td ({text}) Tj ET'.encode() if text else b''
    objects = [
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R '
        b'/Resources << /Font << /F1 5 0 R >> >> >>',
        b'<< /Length %d >>\nstream\n' % len(content) + content + b'\nendstream',
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ]
    out = io.BytesIO(b'%PDF-1.4\n')
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(b'%d 0 obj\n' % i + body + b'\nendobj\n')
    xref = out.tell()
    out.write(b'xref\n0 %d\n0000000000 65535 f \n' % (len(objects) + 1))
    for off in offsets:
        out.write(b'%010d 00000 n \n' % off)
    out.write(b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objects) + 1, xref))
    return out.getvalue()


def _docx(paragraphs: list[str], table: list[list[str]]) -> bytes:
    w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    para = ''.join(f'<w:p><w:r><w:t>{p}</w:t></w:r></w:p>' for p in paragraphs)
    rows = ''.join(
        '<w:tr>' + ''.join(f'<w:tc><w:p><w:r><w:t>{c}</w:t></w:r></w:p></w:tc>' for c in row) + '</w:tr>'
        for row in table
    )
    xml = (
        f'<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="{w}">'
        f'<w:body>{para}<w:tbl>{rows}</w:tbl></w:body></w:document>'
    )
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as zf:
        zf.writestr('[Content_Types].xml', '<Types/>')
        zf.writestr('word/document.xml', xml)
    return out.getvalue()


def _xlsx() -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = '明细'
    ws.append(['品名', '数量', '单价'])
    ws.append(['打印纸', 3, 25.5])
    wb.create_sheet('备注').append(['供应商：华东文具'])
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


@pytest.mark.parametrize(
    ('raw', 'ext', 'expect'),
    [
        ('报销事由：拜访客户\n金额 1280 元'.encode(), 'txt', '金额 1280 元'),
        ('发票抬头,金额\n华东电子,1280'.encode('gbk'), 'csv', '华东电子'),
        (_pdf('Invoice total 1280 CNY'), 'pdf', 'Invoice total 1280 CNY'),
        (_docx(['差旅说明', '去上海见客户'], [['项目', '金额'], ['高铁', '553']]), 'docx', '高铁\t553'),
        (_xlsx(), 'xlsx', '打印纸\t3\t25.5'),
    ],
    ids=['txt', 'csv-gbk', 'pdf', 'docx', 'xlsx'],
)
def test_supported_formats_are_read(raw: bytes, ext: str, expect: str) -> None:
    got = extract_text(raw, ext, max_chars=4000)
    assert got.note is None, got
    assert expect in (got.text or '')


def test_xlsx_reads_every_sheet() -> None:
    text = extract_text(_xlsx(), 'xlsx', max_chars=4000).text or ''
    assert '# 明细' in text and '# 备注' in text and '华东文具' in text


def test_docx_keeps_paragraphs_before_the_table() -> None:
    text = extract_text(_docx(['第一段', '第二段'], [['甲', '乙']]), 'docx', max_chars=4000).text or ''
    assert text.index('第一段') < text.index('第二段') < text.index('甲\t乙')


@pytest.mark.parametrize(
    ('raw', 'ext', 'note'),
    [
        (_pdf(None), 'pdf', '没有可读的文字'),
        (b'not a zip', 'docx', '读不出来'),
        (b'%PDF-1.4 garbage', 'pdf', '读不出来'),
        (b'\x89PNG\r\n', 'png', '不支持'),
        (b'whatever', 'pptx', '不支持'),
        (b'   \n  ', 'txt', '没有可读的文字'),
    ],
    ids=['scanned-pdf', 'broken-docx', 'broken-pdf', 'image', 'pptx', 'blank-txt'],
)
def test_unreadable_files_say_why_and_never_raise(raw: bytes, ext: str, note: str) -> None:
    """🔴 读不出来要给原因：空串会让模型以为附件本来就是空的"""
    got = extract_text(raw, ext, max_chars=4000)
    assert got.text is None
    assert note in (got.note or ''), got


def test_long_text_is_cut_and_says_so() -> None:
    got = extract_text(('事由' * 5000).encode(), 'txt', max_chars=100)
    assert got.text is not None and len(got.text) == 100
    assert got.truncated and '只读了前 100 个字' in (got.note or '')


def test_docx_zip_bomb_is_refused_before_inflating(monkeypatch: pytest.MonkeyPatch) -> None:
    """docx 也是 zip：解压体积超限直接拒，不先解出来（同 xlsx 那条）"""
    monkeypatch.setattr(doc_text.settings, 'TABLE_IMPORT_UNCOMPRESSED_MAX', 200)
    got = extract_text(_docx(['很长的一段' * 50], []), 'docx', max_chars=4000)
    assert got.text is None and '读不出来' in (got.note or '')


def test_pdf_pages_beyond_the_cap_are_not_read(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(doc_text, 'PDF_MAX_PAGES', 0)
    got = extract_text(_pdf('Invoice total 1280 CNY'), 'pdf', max_chars=4000)
    assert got.text is None, '页数上限没生效'
