"""
后端 i18n 静态一致性检查。

不测「翻得对不对」（要人读），只测「结构还对不对」——机器能查的交给机器查，
同 `pnpm ctx:check` 的思路。2026-08-22 治理三期把业务错误消息从「中文原文
当 key」迁到了「稳定点分键」（见 `apps/api/AGENTS.md`「后端国际化」一节），
这两条断言就是防止它重新腐烂：

1. `error.*` / `file_type.*` 在 zh-CN.yml / en-US.yml 里的键集合必须完全一致
   —— 两边任一边漏加一个键，`t()` 会把没查到的那一侧原样吐出键名字符串
   （比如 `'error.dept.something'`），这条测试要在它上线前抓到，而不是等
   用户在英文界面看到一串没翻译的键名。
2. 源码里每一处 `t('error.xxx.yyy')` / `t('file_type.xxx')` 调用，引用的键
   必须在 zh-CN.yml 里真实存在——防止手写键名打错字、或者改了 key 名字
   忘了同步某个调用点。
"""

import re

from pathlib import Path

import yaml

_API_ROOT = Path(__file__).resolve().parents[2]
_LOCALE_DIR = _API_ROOT / 'backend' / 'locale'
_BACKEND_DIR = _API_ROOT / 'backend'

# 只关心业务消息用的两个命名空间；pydantic/response/success/messages 那几段
# 各自的对称规则不一样（结构性原因见 zh-CN.yml / en-US.yml 顶部注释），
# 不纳入这条通用检查。
_CHECKED_NAMESPACES = ('error', 'file_type')

# 源码里引用 t() 键的调用形式：`t('error.xxx')` / `t("file_type.xxx")`，
# 也覆盖带 kwargs 的调用（`t('error.xxx', foo=bar)`）。第二个参数如果是
# 位置参数字符串（`t(key, default)`）不会被误伤，因为那类调用本仓库没有用到。
_T_CALL_PATTERN = re.compile(r"\bt\(\s*(['\"])((?:error|file_type)\.[\w.]+)\1")


def _flatten(d: dict, prefix: str = '') -> set[str]:
    keys = set()
    for k, v in d.items():
        p = f'{prefix}.{k}' if prefix else k
        if isinstance(v, dict):
            keys |= _flatten(v, p)
        else:
            keys.add(p)
    return keys


def _load_locale(name: str) -> dict:
    return yaml.safe_load((_LOCALE_DIR / name).read_text(encoding='utf-8'))


def _checked_keys(locale: dict) -> set[str]:
    keys = set()
    for ns in _CHECKED_NAMESPACES:
        if ns in locale:
            keys |= _flatten({ns: locale[ns]})
    return keys


def test_error_and_file_type_keys_are_symmetric() -> None:
    """zh-CN.yml / en-US.yml 在 error.* / file_type.* 下的键集合必须完全一致。"""
    zh_keys = _checked_keys(_load_locale('zh-CN.yml'))
    en_keys = _checked_keys(_load_locale('en-US.yml'))

    only_in_zh = zh_keys - en_keys
    only_in_en = en_keys - zh_keys

    assert not only_in_zh, f'en-US.yml 缺这些键（会在英文界面原样吐出键名): {sorted(only_in_zh)}'
    assert not only_in_en, f'zh-CN.yml 缺这些键（孤儿翻译，源码已经不再引用或本来就没有): {sorted(only_in_en)}'


def test_every_t_call_key_exists_in_locale() -> None:
    """源码里每一处 t('error.xxx') / t('file_type.xxx') 引用的键都必须在语言包里存在。"""
    zh_keys = _checked_keys(_load_locale('zh-CN.yml'))

    referenced: dict[str, list[str]] = {}
    for path in _BACKEND_DIR.rglob('*.py'):
        if '/tests/' in path.as_posix() or path.name == 'i18n.py':
            continue
        text = path.read_text(encoding='utf-8')
        for m in _T_CALL_PATTERN.finditer(text):
            key = m.group(2)
            referenced.setdefault(key, []).append(str(path.relative_to(_API_ROOT)))

    missing = {key: files for key, files in referenced.items() if key not in zh_keys}
    assert not missing, f'源码引用了语言包里不存在的键（打错字或改名没同步): {missing}'
