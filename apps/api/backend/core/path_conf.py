import os

from pathlib import Path

# 项目根目录
BASE_PATH = Path(__file__).resolve().parent.parent

# 环境变量文件 —— 文件名可用 ENV_FILE 环境变量覆盖（E2E 用它指向 .env.e2e，
# 跑一套连 fba_test、关验证码的隔离实例）。不设置这个变量时行为和以前完全一样。
ENV_FILE_PATH = BASE_PATH / os.environ.get('ENV_FILE', '.env')

# 环境变量示例文件
ENV_EXAMPLE_FILE_PATH = BASE_PATH / '.env.example'

# alembic 迁移文件存放路径
ALEMBIC_VERSION_DIR = BASE_PATH / 'alembic' / 'versions'

# 日志文件路径
LOG_DIR = BASE_PATH / 'log'

# 静态资源目录
STATIC_DIR = BASE_PATH / 'static'

# 上传文件目录
#
# ⚠️ 刻意**不放在 STATIC_DIR 下面**。原来是 `STATIC_DIR / 'upload'`，
# 而 registrar 会 `app.mount('/static', StaticFiles(directory=STATIC_DIR))` ——
# 于是上传物被父级挂载连带公开了：不登录也能按文件名下载别人的文件。
# 实测过：单独删掉 `/static/upload` 那条 mount 没用，`/static` 覆盖着它。
UPLOAD_DIR = BASE_PATH / 'upload'

# 公开上传目录 —— 富文本正文里的内联图片落在这里，被 `/uploads` 静态挂出去
#
# 为什么要有这么一棵**独立**的子树，而不是在 UPLOAD_DIR 里开个 `public/` 子目录：
# 「公开」和「私有」共用一个根，就只剩「谁记得别给根目录加 mount」这一道纪律在守着，
# 而上面那段注释记的正是这条纪律被破掉一次的实测结果（`/static` 覆盖 `/static/upload`）。
# 两棵树物理分开之后，挂错的唯一方式是显式写出另一个常量名。
#
# ⚠️ 落在这里的文件**不需要登录就能读**，随机后缀（build_filename 的 64 bit）
# 是它唯一的访问控制 —— 也就是「知道 URL 的人能看」。所以：
# 1. 只允许图片进来（file_service.upload 强制校验，不是靠调用方自觉）
# 2. `?public=true` 只接在富文本编辑器的上传路径上，**绝不接到「文件管理」页的
#    通用上传按钮** —— 那里会有身份证扫描件之类的图片，「只允许图片」挡不住它
PUBLIC_UPLOAD_DIR = BASE_PATH / 'upload-public'

# 插件目录
PLUGIN_DIR = BASE_PATH / 'plugin'

# 国际化文件目录
LOCALE_DIR = BASE_PATH / 'locale'

# MySQL 脚本目录
MYSQL_SCRIPT_DIR = BASE_PATH / 'sql' / 'mysql'

# PostgreSQL 脚本目录
POSTGRESQL_SCRIPT_DIR = BASE_PATH / 'sql' / 'postgresql'

# SQL Server 脚本目录
SQLSERVER_SCRIPT_DIR = BASE_PATH / 'sql' / 'sqlserver'

# 热重载锁文件
RELOAD_LOCK_FILE = BASE_PATH / '.reload.lock'
