from celery.backends.database.session import SessionManager as CelerySessionManager


class SessionManager(CelerySessionManager):
    """重写 celery 的 SessionManager，禁止它自动建表。

    表由 `MappedBase.metadata.create_all()` 从我们自己的模型生成
    （`model/result.py`），celery 内建那套建出来的列类型在 SQL Server 上是错的
    —— 见那个文件里的三条注释。
    """

    def __init__(self) -> None:
        super().__init__()
        self.prepared = True
