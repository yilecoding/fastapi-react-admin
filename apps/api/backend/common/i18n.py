import glob
import json
import re

from pathlib import Path
from typing import Any

import yaml

from starlette_context.errors import ContextDoesNotExistError

from backend.common.context import ctx
from backend.core.conf import settings
from backend.core.path_conf import LOCALE_DIR


class I18n:
    """国际化管理器"""

    def __init__(self) -> None:
        self.locales: dict[str, dict[str, Any]] = {}
        self._template_cache: dict[str, list[tuple[re.Pattern[str], str]]] = {}
        self.load_locales()

    @property
    def current_language(self) -> str:
        """获取当前请求的语言"""
        try:
            return ctx.language
        except (AttributeError, LookupError, ContextDoesNotExistError):
            return settings.I18N_DEFAULT_LANGUAGE

    @current_language.setter
    def current_language(self, language: str) -> None:
        """设置当前请求的语言"""
        ctx.language = language

    def load_locales(self) -> None:
        """加载语言文本"""
        patterns = [
            LOCALE_DIR / '*.json',
            LOCALE_DIR / '*.yaml',
            LOCALE_DIR / '*.yml',
        ]

        lang_files = []

        for pattern in patterns:
            lang_files.extend(glob.glob(str(pattern)))

        for lang_file in lang_files:
            with open(lang_file, encoding='utf-8') as f:
                lang = Path(lang_file).stem
                file_type = Path(lang_file).suffix[1:]
                match file_type:
                    case 'json':
                        self.locales[lang] = json.loads(f.read())
                    case 'yaml' | 'yml':
                        self.locales[lang] = yaml.safe_load(f.read())

    def t(self, key: str, default: Any | None = None, **kwargs) -> str:
        """
        翻译函数

        :param key: 目标文本键，支持点分隔，例如 'response.success'
        :param default: 目标语言文本不存在时的默认文本
        :param kwargs: 目标文本中的变量参数
        :return:
        """
        keys = key.split('.')

        try:
            translation = self.locales[self.current_language]
        except KeyError:
            keys = 'error.language_not_found'.split('.')
            translation = self.locales[settings.I18N_DEFAULT_LANGUAGE]

        for k in keys:
            if isinstance(translation, dict) and k in list(translation.keys()):
                translation = translation[k]
            else:
                # Pydantic 兼容
                translation = None if keys[0] == 'pydantic' else key
                break

        if translation and kwargs:
            translation = translation.format(**kwargs)

        return translation or default

    def tm(self, text: str) -> str:
        """
        业务消息翻译。

        与 `t()` 不同：`t()` 走点分隔的**键**（`response.success`），
        而业务代码里的 `raise errors.XxxError(msg='用户不存在')` 是**中文字面量**，
        全仓库 189 处、28 个文件。逐个改成 `t('error.user.not_found')`
        会在 fork 里铺开 28 个文件的冲突面，而这是个纯增量特性 ——
        所以改成**在响应出口按中文原文查表**，调用点一行都不动。

        两级查找：

        1. `messages` 精确匹配（95 条静态文案）
        2. `message_templates` 模板匹配（22 条带变量的，如
           `此文件格式 {file_ext} 暂不支持` —— 插值之后没法精确匹配，
           所以按 `{}` 占位符生成正则去套，捕获组按顺序填进目标语言模板）

        查不到就原样返回 —— **降级成原文，而不是丢失信息**。
        默认语言在没有 `messages` 表时直接短路，不付任何代价（见下方注释）。

        :param text: 中文原文
        :return:
        """
        lang = self.current_language
        locale = self.locales.get(lang)
        if not locale:
            return text

        exact = locale.get('messages') or {}

        # 默认语言（zh-CN）通常不需要翻 —— 原文就是中文，短路掉不付任何代价。
        # 但**框架抛的文案是英文的**（HTTPBearer 的 'Not authenticated'、
        # starlette 的 'Method Not Allowed'），中文界面下反而需要翻。
        # 所以短路条件是「默认语言 **且** 这个语言没有 messages 表」，
        # 而不是「默认语言」—— zh-CN 补了 messages 段之后就照常查表。
        if lang == settings.I18N_DEFAULT_LANGUAGE and not exact:
            return text
        hit = exact.get(text)
        if hit:
            return hit

        for zh_tpl, target_tpl in self._templates(lang):
            m = zh_tpl.fullmatch(text)
            if m:
                try:
                    return target_tpl.format(*m.groups())
                except (IndexError, KeyError):
                    return text

        return text

    def _templates(self, lang: str) -> list[tuple[re.Pattern[str], str]]:
        """把 `message_templates` 编译成正则，按语言缓存"""
        cached = self._template_cache.get(lang)
        if cached is not None:
            return cached

        compiled: list[tuple[re.Pattern[str], str]] = []
        for pair in (self.locales.get(lang) or {}).get('message_templates') or []:
            if not isinstance(pair, list) or len(pair) != 2:
                continue
            zh, target = pair
            # 中文模板里的 `{}` 是占位符，其余部分按字面量转义
            pattern = ''.join(
                '(.+?)' if part == '{}' else re.escape(part)
                for part in re.split(r'(\{\})', zh)
                if part
            )
            compiled.append((re.compile(pattern, re.DOTALL), target))

        self._template_cache[lang] = compiled
        return compiled


# 创建 i18n 单例
i18n = I18n()

# 创建翻译函数实例
t = i18n.t

# 业务消息翻译（按中文原文查表，见 I18n.tm）
tm = i18n.tm
