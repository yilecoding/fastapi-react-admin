# OAuth2

OAuth 2.0 第三方登录插件，支持 GitHub、Google 等社交平台登录

- 支持 GitHub、Google 第三方登录
- 支持第三方账号绑定与解绑
- 支持登录回跳和绑定回跳配置

## 插件类型

- 应用级插件

## 配置说明

在 `backend/.env` 中添加以下内容：

```env
# [ Plugin ] oauth2
OAUTH2_GITHUB_CLIENT_ID='test'
OAUTH2_GITHUB_CLIENT_SECRET='test'
OAUTH2_GOOGLE_CLIENT_ID='test'
OAUTH2_GOOGLE_CLIENT_SECRET='test'
```

插件目录下 `plugin.toml` 的 `[settings]` 中包含以下内容：

```toml
[settings]
OAUTH2_FRONTEND_BINDING_REDIRECT_URI = 'http://localhost:8888/profile'
OAUTH2_FRONTEND_LOGIN_REDIRECT_URI = 'http://localhost:8888/oauth2/callback'
OAUTH2_GITHUB_REDIRECT_URI = 'http://127.0.0.1:8000/api/v1/oauth2/github/callback'
OAUTH2_GOOGLE_REDIRECT_URI = 'http://127.0.0.1:8000/api/v1/oauth2/google/callback'
OAUTH2_STATE_EXPIRE_SECONDS = 180
OAUTH2_STATE_REDIS_PREFIX = 'fba:oauth2:state'
```

在 `backend/core/conf.py` 中添加以下内容：

```python
##################################################
# [ Plugin ] oauth2
##################################################
# .env
OAUTH2_GITHUB_CLIENT_ID: str
OAUTH2_GITHUB_CLIENT_SECRET: str
OAUTH2_GOOGLE_CLIENT_ID: str
OAUTH2_GOOGLE_CLIENT_SECRET: str

# 基础配置（in plugin.toml）
OAUTH2_STATE_REDIS_PREFIX: str
OAUTH2_STATE_EXPIRE_SECONDS: int
OAUTH2_GITHUB_REDIRECT_URI: str
OAUTH2_GOOGLE_REDIRECT_URI: str
OAUTH2_FRONTEND_LOGIN_REDIRECT_URI: str
OAUTH2_FRONTEND_BINDING_REDIRECT_URI: str
```

## 第三方账号第一次登录：默认不自动建号（#226）

陌生的第三方账号（库里没有绑定、邮箱也对不上任何用户）**默认被拒绝**，提示「先用账号密码登录，再到个人中心绑定」。
1.0.x 及之前是无条件自动建号，并挂上「第一个启用的角色」（没有排序，挂到哪个取决于数据库行序）——
任何人用自己的 GitHub / Google 账号走一遍就成了系统用户。

确实要开放自助注册的部署，在 `backend/.env` 里显式打开，并指定新用户挂的角色编码：

```env
OAUTH2_AUTO_REGISTER=true
OAUTH2_AUTO_REGISTER_ROLE='STAFF'   # sys_role.code；找不到 / 已停用就拒绝登录，不会退回别的角色
```

## 使用方式

1. 安装并启用插件后，在 GitHub、Google 开放平台分别创建 OAuth 应用
2. 将平台分配的 Client ID、Client Secret 配置到项目环境变量中
3. 确保平台回调地址与 `OAUTH2_GITHUB_REDIRECT_URI`、`OAUTH2_GOOGLE_REDIRECT_URI` 保持一致
4. 配置前端登录回跳地址与绑定回跳地址
5. 重启后端服务后，使用第三方登录、绑定和解绑能力

## 卸载说明

- 卸载插件后，建议同步移除相关环境变量、插件基础配置和 `backend/core/conf.py` 中的插件配置
- 如前端登录页或个人中心已集成第三方登录、绑定等能力，请同步清理对应集成

## 联系方式

- 原作者：`wu-clan`（上游 FBA 插件，本仓库沿用）
- 反馈方式：提交 Issue 或 PR
