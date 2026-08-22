import glob
import json

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
        框架异常反向翻译。

        与 `t()` 的关系：业务代码现在统一走 `t('error.xxx.yyy', **kwargs)`——
        稳定键 + `.format(**kwargs)`，2026-08-22 前是反过来（`tm()` 按中文
        原文查表），改掉的原因和踩过的坑记在 `apps/api/AGENTS.md`「后端
        国际化」一节。`tm()` 现在只留给**我们不控制抛出点**的那一类文案：
        FastAPI/Starlette 自己抛出来的英文原文（`HTTPBearer` 的
        'Not authenticated'、starlette 的 'Method Not Allowed' 之类）——
        这种情况下我们拿不到一个可以传参数的调用点，只能反过来拿原文当 key。

        `exception_handler.py` 在 `exc.msg`/`exc.detail` 上无差别地调用它：
        业务异常这时已经是 `t()` 产出的最终文案，查不到表就原样返回，
        对已翻译文本是幂等的；框架异常则是这张表唯一还需要处理的东西。

        :param text: 原文（通常是框架抛出的英文文案）
        :return:
        """
        lang = self.current_language
        locale = self.locales.get(lang)
        if not locale:
            return text

        exact = locale.get('messages') or {}

        # 默认语言（zh-CN）通常不需要翻 —— 原文就是中文，短路掉不付任何代价。
        # 但**框架抛的文案是英文的**，中文界面下反而需要翻，所以短路条件是
        # 「默认语言 **且** 这个语言没有 messages 表」，而不是「默认语言」。
        if lang == settings.I18N_DEFAULT_LANGUAGE and not exact:
            return text

        return exact.get(text) or text


# 创建 i18n 单例
i18n = I18n()

# 创建翻译函数实例
t = i18n.t

# 业务消息翻译（按中文原文查表，见 I18n.tm）
tm = i18n.tm
