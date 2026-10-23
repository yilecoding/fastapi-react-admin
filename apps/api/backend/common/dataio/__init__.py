"""导入导出的公共层（#11 · v0.4）。

```
cells.py     一个 Python 值 → 写进 Excel / CSV 不会出事的单元格（公式注入 · 19 位 ID · 时区 · 控制字符）
writers.py   流式写 xlsx / csv（内存恒定，几十万行不涨）
exporting.py 导出定义（列 · 筛选参数 · 怎么取数）+ 登记表
importing.py 导入定义（列 · 逐行校验 · 怎么落库）+ 登记表
```

这一层**不碰数据库会话、不碰请求**：取数怎么走数据权限、文件存哪、谁能下载，
都在 `app/admin/service/export_service.py` / `import_service.py`。
各资源（用户、部门、日志、字典、公告）只写一份「定义」，登记到这里。

设计取舍和实测证据见同目录的 `AGENTS.md`。
"""
