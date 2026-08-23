# ⚠️ 同 apps/api/Dockerfile.prod：不写 `# syntax=`，避免每次构建都要够得着 docker.io。
#
# 前端生产镜像。**构建上下文是仓库根**，不是 apps/web：
#
#     docker build -f apps/web/Dockerfile -t fba-web .
#
# 🔴 **不能用 `pnpm deploy` 把依赖拍平。** 两个原因，任一都足够：
#   1. `packages/{ui,platform,i18n}` 是**源码包** —— 没有 build 脚本，
#      `exports` 直接指向 `src/*.ts(x)`，没有可发布的产物可供 deploy 收集
#   2. `apps/web/vite.config.ts` 的 alias 写死了
#      `path.resolve(import.meta.dirname, "../../packages/platform/src")` 这类**相对路径**，
#      deploy 会把依赖拍进 `bundle/node_modules`，那个相对布局就没了，构建直接找不到模块
# 所以保留 workspace 的原始目录结构，整仓 COPY。代价只是构建阶段镜像大一点，
# 多阶段之后丢弃，运行镜像里只有 dist + nginx。

FROM node:22-bookworm-slim AS builder
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate
WORKDIR /repo

# 先只拷清单，命中 pnpm store 缓存
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.json ./
COPY apps/web/package.json      apps/web/
COPY apps/api/package.json      apps/api/
COPY apps/worker/package.json   apps/worker/
COPY apps/desktop/package.json  apps/desktop/
COPY packages/ui/package.json       packages/ui/
COPY packages/platform/package.json packages/platform/
COPY packages/i18n/package.json     packages/i18n/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile --filter web... --filter .

COPY . .

# 🔴 空串 = 同源相对路径，这是「一次构建、多环境复用」的唯一办法。
# `packages/platform/src/api-client/client.ts` 的
# `API_BASE = import.meta.env?.VITE_API_BASE ?? 'http://127.0.0.1:8000'`
# 是**构建期**写死的，socket.io 地址和富文本图片的绝对 URL 都拼它 ——
# 用默认值构建出来的产物只能连本机。
# `??` 是 nullish 合并，空串会被保留（写 `||` 就会退回默认值，别改）。
ARG VITE_API_BASE=""
RUN printf 'VITE_API_BASE=%s\n' "$VITE_API_BASE" > apps/web/.env.production \
 && pnpm --filter web build

FROM nginx:1.27-alpine AS runtime
ENV TZ=Asia/Shanghai
COPY --from=builder /repo/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
    CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1
