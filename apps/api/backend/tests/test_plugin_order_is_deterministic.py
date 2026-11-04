"""插件 / 路由的加载顺序不能取决于文件系统（#234 顺带发现）

`os.listdir` / `os.walk` 返回的是文件系统自己的顺序，不同机器不同。插件顺序决定路由注册顺序 ——
于是同一份代码在开发机和 CI 上导出的 OpenAPI 路由顺序不同（`schema.d.ts` 新鲜度闸门第一次跑就因此红了），
FastAPI 按注册顺序匹配路由，两台机器上的路由优先级也可能不一样。

实测（2026-11-04）：把 `os.listdir` / `os.walk` 的结果反过来再导出，不排序时路由顺序在第 94 条分叉，
排序之后两次导出逐字节一致。这里只钉住最外层那一处（便宜、不用起整个 app）。
"""

import os

import pytest

from backend.plugin import core


def test_get_plugins_ignores_filesystem_order(monkeypatch: pytest.MonkeyPatch) -> None:
    real = os.listdir
    core.get_plugins.cache_clear()
    try:
        natural = core.get_plugins()
        assert len(natural) >= 3, '先断言「有」：插件目录里至少要扫出几个插件'
        core.get_plugins.cache_clear()
        monkeypatch.setattr(core.os, 'listdir', lambda p='.': list(reversed(real(p))))
        assert core.get_plugins() == natural
        assert list(natural) == sorted(natural)
    finally:
        core.get_plugins.cache_clear()
