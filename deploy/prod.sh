#!/usr/bin/env bash
#
# 生产部署入口。
#
# 🔴 **这份文件必须能单独跑。** 部署机器上没有仓库、没有 pnpm、没有 node_modules ——
# 只有三份文件：这个脚本 + docker-compose.prod.yml + .env.server。所以这里不 source
# 仓库里的任何东西、不依赖 package.json、不假设 cwd 在仓库根。前身
# `scripts/deploy-prod.mjs` 就是栽在这个假设上：入口是 `pnpm deploy:prod`，
# 而服务器上压根没有 pnpm，于是所有人（和 Claude）都绕过它手敲裸 docker compose，
# 前置检查一次都没跑过。
#
# 用法（仓库里 / 服务器上都一样）：
#
#     bash deploy/prod.sh <命令>          # 仓库根
#     bash prod.sh <命令>                 # 服务器上，和 compose 放同一层
#
# 命令：
#   config   展开并校验 compose，不启动任何东西
#   build    在本机从源码构建（只有仓库在的时候能用，和 pull 二选一）
#   pull     拉 CI 已经推到 GHCR 的镜像（配 FBA_PULL_MIRROR 时走加速器 + 自动 retag）
#   up       启动（先跑 migrate，成功了才起 api/worker/beat/web），再经 web 探 /api/health/ready
#   down     停止容器。永远不带 -v —— 这个脚本不给传任何额外参数就是为了这个
#   logs     跟踪最近 200 行
#   status   在跑的是哪个提交、和 main 差多少
#   sync     把 compose 文件更新成仓库里的版本（服务器上唯一正确的改法）
#
# 可调项（环境变量，或写进 compose 文件同级的 .env）：
#   FBA_ENV_FILE     .env.server 的位置，相对 compose 文件。默认仓库里的那个深路径
#   FBA_WEB_PORT     web 容器映射到宿主机的端口，默认 80（compose 里读）
#   FBA_PULL_MIRROR  GHCR 加速器域名，如 ghcr.nju.edu.cn。国内机器基本必填
#   IMAGE_OWNER      镜像属主，默认 yilecoding
#   TAG              镜像标签，默认 latest；回滚时设成 sha-<短 SHA>
set -euo pipefail

REPO_NAME=fastapi-react-admin

fail() {
  printf '\033[31m✗\033[0m %s\n' "$1" >&2
  shift
  for line in "$@"; do printf '  %s\n' "$line" >&2; done
  exit 1
}
info() { printf '\033[36m·\033[0m %s\n' "$*" >&2; }
warn() {
  printf '\033[33m!\033[0m %s\n' "$1" >&2
  shift
  for line in "$@"; do printf '  %s\n' "$line" >&2; done
}
ok() { printf '\033[32m✓\033[0m %s\n' "$*" >&2; }

command=${1:-}
case $command in
  '' | -h | --help | help)
    # 顶部注释就是帮助文本。按「第 3 行起、到第一个非注释行为止」取，
    # 不写死行号 —— 写死的话改一次注释就静默少印半屏
    awk 'NR > 2 && /^#/ { sub(/^# ?/, ""); print; next } NR > 2 { exit }' "${BASH_SOURCE[0]}"
    exit 0
    ;;
  config | build | pull | up | down | logs | status | sync) ;;
  *) fail "不支持的命令 $command" "可用：config build pull up down logs status sync" ;;
esac

# ── 定位 compose 文件 ────────────────────────────────────────────────────
# 仓库里脚本在 deploy/ 下、compose 在上一层；服务器上两者可能同层。都试一遍，
# 顺序固定，别靠 cwd —— 从别的目录 `bash /path/to/prod.sh` 也要能跑。
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
compose=""
for candidate in \
  "${FBA_COMPOSE_FILE:-}" \
  "$script_dir/../docker-compose.prod.yml" \
  "$script_dir/docker-compose.prod.yml" \
  "$PWD/docker-compose.prod.yml"; do
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then
    compose=$candidate
    break
  fi
done
[ -n "$compose" ] || fail \
  "找不到 docker-compose.prod.yml" \
  "在这些位置找过：脚本上一层 / 脚本同层 / 当前目录（$PWD）" \
  "也可以显式指定：FBA_COMPOSE_FILE=/path/to/docker-compose.prod.yml"

project_dir=$(cd -- "$(dirname -- "$compose")" && pwd -P)
compose="$project_dir/$(basename -- "$compose")"

# ── 读 compose 同级的 .env ───────────────────────────────────────────────
# docker compose 自己会读它做变量插值，但 shell 不会 —— 前置检查要知道
# .env.server 到底在哪，就得自己读一遍同一份文件，否则两边看到的路径会不一致。
dotenv_get() {
  local key=$1 line
  [ -f "$project_dir/.env" ] || return 1
  line=$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$project_dir/.env" | tail -n1) || return 1
  line=${line#*=}
  line=${line%%[[:space:]]#*}
  line=${line%\"}
  line=${line#\"}
  line=${line%\'}
  line=${line#\'}
  [ -n "$line" ] && printf '%s\n' "$line"
}

setting() { # setting <环境变量名> <默认值>
  local key=$1 default=$2
  if [ -n "${!key:-}" ]; then
    printf '%s\n' "${!key}"
  else
    dotenv_get "$key" || printf '%s\n' "$default"
  fi
}

env_rel=$(setting FBA_ENV_FILE "./apps/api/deploy/backend/docker-compose/.env.server")
case $env_rel in
  /*) env_file=$env_rel ;;
  *) env_file="$project_dir/${env_rel#./}" ;;
esac
image_owner=$(setting IMAGE_OWNER yilecoding)
pull_mirror=$(setting FBA_PULL_MIRROR "")

# ── 前置检查 ─────────────────────────────────────────────────────────────
stat_fmt() { # stat_fmt <linux 格式> <bsd 格式> <文件>
  stat -c "$1" "$3" 2>/dev/null || stat -f "$2" "$3"
}

check_env_file() {
  [ -f "$env_file" ] || fail \
    "找不到 $env_file" \
    "先从模板拷一份并填掉里面的 CHANGE_ME：" \
    "  cp apps/api/deploy/backend/docker-compose/.env.server.example $env_file" \
    "服务器上没有仓库的话，模板在 GitHub：" \
    "  https://raw.githubusercontent.com/$image_owner/$REPO_NAME/main/apps/api/deploy/backend/docker-compose/.env.server.example"

  local mode
  mode=$(stat_fmt '%a' '%OLp' "$env_file")
  if [ $((8#$mode & 8#077)) -ne 0 ]; then
    fail "$env_file 权限是 $mode，生产环境必须是 600" "  chmod 600 $env_file"
  fi

  if grep -v '^[[:space:]]*#' "$env_file" | grep -qi 'CHANGE_ME'; then
    fail "$env_file 里还有 CHANGE_ME 占位值没填"
  fi
}

# 🔴 属主必须是 uid 1000。Dockerfile.prod 里进程是 `USER fba`（uid 1000），
# 而上面又要求权限严格 600 —— owner 不是 1000 的话容器里根本读不到这份文件，
# 报错是 pydantic-settings 内部的 PermissionError，字面上不含「权限」两个字，
# 很容易当成配置写错了去查。只在 up 时校验：config/pull 不挂载，管不着。
check_env_owner() {
  local uid
  uid=$(stat_fmt '%u' '%u' "$env_file")
  if [ "$uid" != "1000" ]; then
    fail \
      "$env_file 属主 uid 是 $uid，容器里的进程是 uid 1000（USER fba），读不到它" \
      "宿主机上看权限没问题，容器里会在加载配置那一步 PermissionError：" \
      "  chown 1000:1000 $env_file"
  fi
}

require_docker() {
  command -v docker >/dev/null 2>&1 || fail "没装 docker"
  docker compose version >/dev/null 2>&1 ||
    fail "docker compose (v2) 不可用" "这个脚本只支持 v2 的 \`docker compose\`，不支持 v1 的 \`docker-compose\`"
}

dc() { docker compose -f "$compose" "$@"; }

# ── GitHub 上的 main 是哪个提交 ──────────────────────────────────────────
# Accept: application/vnd.github.sha 让接口直接返回一个裸 SHA，省掉解析 JSON。
remote_head() {
  local sha
  sha=$(curl -fsS --max-time 15 -H 'Accept: application/vnd.github.sha' \
    "https://api.github.com/repos/$image_owner/$REPO_NAME/commits/main" 2>/dev/null || true)
  # 限流 / 仓库不可见时接口会返回一段 JSON，别把它当成提交号去比
  case $sha in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) [ ${#sha} -eq 40 ] && printf '%s\n' "$sha" ;;
  esac
}

# image_label <容器 id> <标签名>：读容器所用镜像的 OCI 标签，没有就是空串
image_label() {
  local value
  value=$(docker inspect "$1" --format "{{index .Config.Labels \"$2\"}}" 2>/dev/null || true)
  [ "$value" = '<no value>' ] && value=''
  printf '%s\n' "$value"
}

# json_str <字段名>：从标准输入的紧凑 JSON 里取一个**字符串**字段的值；字段不在或是 null 时输出空。
# 不用 jq —— 服务器上不保证有，而这里读的两份 JSON（/api/health/status、/version.json）都是我们自己出的紧凑格式
json_str() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -n1; }

cmd_status() {
  dc ps
  echo
  local head
  head=$(remote_head)
  local -a ids
  mapfile -t ids < <(dc ps -q 2>/dev/null || true)
  if [ ${#ids[@]} -eq 0 ] || [ -z "${ids[0]}" ]; then
    info "没有正在运行的容器"
    return 0
  fi
  # 只让 ASCII 的两列参与对齐 —— printf 的宽度是按**字节**算的，中文列
  # 混进来必然错位（一个汉字 3 字节、显示 2 格）
  info "各容器跑的是哪个版本 / 提交："
  local id name rev ver short state
  for id in "${ids[@]}"; do
    [ -n "$id" ] || continue
    name=$(docker inspect "$id" --format '{{.Name}}' 2>/dev/null || true)
    name=${name#/}
    rev=$(image_label "$id" org.opencontainers.image.revision)
    # 版本号标签是 #378 才加的，更早的镜像没有 —— 显示 `-`，不影响下面按提交号的判断
    ver=$(image_label "$id" org.opencontainers.image.version)
    if [ -z "$rev" ]; then
      short='-'
      state='镜像没带 revision 标签（CI 加标签之前构建的），只能靠 pull 时间判断新旧'
    else
      short=${rev:0:7}
      if [ -z "$head" ]; then
        state='(取不到 GitHub 上的 main，无法比对)'
      elif [ "$rev" = "$head" ]; then
        state='已是 main 最新'
      else
        state="落后于 main（${head:0:7}）"
      fi
    fi
    printf '  %-30s %-9s %-8s %s\n' "$name" "${ver:--}" "$short" "$state"
  done
}

# ── pull：国内机器直连 ghcr.io 会被限速到几十 KB/s，走加速器再 retag ──────
# 加速器只是同一份内容换了个路径前缀，不能直接写进 compose 的镜像名（那样
# compose 记住的就是加速器地址了），所以拉完必须 retag 回 ghcr.io/<owner>/…；
# 之后 `up` 发现本地已有同名镜像就不会再去拉。这一串以前是人手敲四条命令。
#
# 🔴 镜像名从 compose 展开（`config --images`），**不在这里再写一份**。原来
# 这里写死了 `fba-api fba-web`，和 compose 是两份真相；镜像改名时只要服务器上
# 两份文件有一份没更新，就是拉 A 起 B：加速器拉的是一个名字，`up` 用的是另一个，
# 而 `up` 只要本地有那个名字的旧 `latest` 就直接起，不报错（按 compose 默认的
# pull_policy: missing 推断，没在服务器上复现过，见 deploy/AGENTS.md）。
# IMAGE_OWNER / TAG 也一并由 compose 自己解析，和 `up` 看到的是同一份。
cmd_pull() {
  if [ -z "$pull_mirror" ]; then
    dc pull
    return
  fi
  info "走加速器 $pull_mirror（拉完自动 retag 回 ghcr.io）"
  local images image
  images=$(dc config --images | sort -u) ||
    fail "从 compose 展开镜像名失败" "先跑 bash prod.sh config 看报错"
  for image in $images; do
    case $image in
      ghcr.io/*) ;;
      *)
        info "跳过 $image（不在 GHCR 上，加速器管不到，交给 up 按需拉）"
        continue
        ;;
    esac
    docker pull "$pull_mirror/${image#ghcr.io/}"
    docker tag "$pull_mirror/${image#ghcr.io/}" "$image"
    ok "${image##*/}"
  done
}

# ── sync：服务器上更新 compose 的唯一正确姿势 ────────────────────────────
# 手改服务器上那份 compose 会制造第二份真相，而且没有任何东西对账 —— 见
# deploy/AGENTS.md「服务器上的 compose 是手抄的」。
cmd_sync() {
  local ref=${1:-main}
  local url="https://raw.githubusercontent.com/$image_owner/$REPO_NAME/$ref/docker-compose.prod.yml"
  local tmp
  tmp=$(mktemp)
  trap 'rm -f "$tmp"' EXIT
  info "从 $ref 取 docker-compose.prod.yml"
  curl -fsS --max-time 30 "$url" -o "$tmp" ||
    fail "下载失败：$url" "网络不通的话，手工把仓库里的 docker-compose.prod.yml 整份覆盖过来"
  if diff -q "$compose" "$tmp" >/dev/null 2>&1; then
    ok "已经和 $ref 一致，没有改动"
    return 0
  fi
  echo
  diff -u "$compose" "$tmp" || true
  echo
  if [ ! -t 0 ]; then
    fail "有差异，但当前不是交互式终端，拒绝自动覆盖" "确认没问题后在终端里再跑一次 sync"
  fi
  local answer
  read -r -p "用 $ref 的版本覆盖 $compose？[y/N] " answer
  case $answer in
    y | Y | yes | YES) ;;
    *) fail "已取消，没有改动任何文件" ;;
  esac
  cp -p "$compose" "$compose.bak"
  cat "$tmp" >"$compose"
  ok "已更新，旧版本留在 $compose.bak"
  info "本机差异（端口 / .env.server 位置）应该写在 $project_dir/.env 里，不要改 compose"
}

# ── up 之后探活：经 web 的 nginx 探，外部监控走的也是这一层 ────────────────
# ready（DB + Redis）必须 200，否则判部署失败 —— 容器全起来了、nginx 那条 location 写错了的话，
# api 自己是好的，监控却一直红。status 只打印不卡：worker / 调度器刚换完，下一拍最多要等 60 秒，
# 心跳阈值是 180 秒，旧进程留下的心跳通常还没过期，所以这里多半已经全是 ok
probe_after_up() {
  local base code=""
  base="http://127.0.0.1:$(setting FBA_WEB_PORT 80)"
  for _ in $(seq 1 20); do
    code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$base/api/health/ready" || true)
    [ "$code" = 200 ] && break
    sleep 3
  done
  [ "$code" = 200 ] || fail \
    "经 web 探 $base/api/health/ready 60 秒内没有 200（最后一次：${code:-无响应}）" \
    "容器起来了，但站点不可用。看日志：bash prod.sh logs" \
    "503 + body 里列着 database / redis 哪项坏了；503 带 X-FBA-Updating 头 = api 没起来；404 = web 的 nginx 配置没跟上"
  ok "经 web 探 /api/health/ready → 200"
  local status_body
  status_body=$(fetch_status_body "$base")
  info "各服务状态 /api/health/status → ${status_body:-无响应}"
  info "scheduler / worker 不是 ok 的话过 3 分钟再看一次，还不是就查那个容器"
  verify_deployed_commit "$base" "$status_body"
}

# 取 /api/health/status 的响应体，**认得出来才算数**（里面有 `"services"`，200 和 503 降级都有）。
# 超时、回了 HTML、nginx 替挂掉的 api 回的 `{"status":"unavailable"}` 都不算，隔 3 秒再取，最多 5 次。
# 🔴 不重试的话，这一下恰好没取到就会被下面当成「旧镜像，没法核对」放行 —— 提交号核对**静默**地没做，
# 而部署照样报成功（#379 评审）。重试完还取不到，原样交回去，由 verify_deployed_commit 大声说出来
fetch_status_body() {
  local base=$1 body=""
  for _ in 1 2 3 4 5; do
    body=$(curl -s -m 10 "$base/api/health/status" || true)
    case $body in *'"services"'*) break ;; esac
    sleep 3
  done
  printf '%s' "$body"
}

# ── up 之后核对：线上答的提交号，是不是刚部署的那个（#378）────────────────────
# 「容器都起来了、探活也 200」不等于「跑的是你要的那一版」：拉 A 起 B、只换了 web 没换 api、
# nginx 还指着旧容器，这些情形探活全绿。这里拿**接口实际答的**提交号对三样东西：
#   1. TAG=sha-<提交号> 时，对你点名要的那个提交
#   2. api 容器镜像的 revision 标签（CI 打的）—— 对不上说明构建时提交号没烙进镜像
#   3. web 的 /version.json —— 对不上说明前后端不是同一次构建
# 🔴 只在**两边都拿得到**时才判失败。回滚到 #378 之前的镜像时接口里根本没有 commit 字段，
# 本机 `build` 的镜像没有 revision 标签 —— 这两种都是「没法核对」，不是「不一致」，拦下来等于把回滚堵死
verify_deployed_commit() {
  local base=$1 body=$2 served tag api_id label web_commit
  # 三种响应分开说，别揉成一句「跳过」：只有第二种是真的「没法核对」
  case $body in
    *'"commit"'*) ;;
    *'"services"'*)
      info "api 没报提交号（镜像早于 #378），跳过提交号核对"
      return 0
      ;;
    *)
      # 重试过了还是认不出来。不判失败：这一步原来就只打印不卡，而回滚时最不该被一个新加的检查拦住。
      # 但要用警告而不是 info —— 「没核对」和「核对过了」不能长得一样
      warn "/api/health/status 没给出认得出来的响应，提交号**没有核对**" \
        "这不是「一致」。过一会儿手工看：curl -s $base/api/health/status"
      return 0
      ;;
  esac
  served=$(printf '%s' "$body" | json_str commit || true)
  api_id=$(dc ps -q api 2>/dev/null | head -n1 || true)
  label=''
  [ -n "$api_id" ] && label=$(image_label "$api_id" org.opencontainers.image.revision)

  if [ -z "$served" ]; then
    [ -z "$label" ] || fail \
      "api 镜像的 revision 标签是 ${label:0:7}，但 /api/health/status 报 commit: null" \
      "提交号没烙进镜像：构建时漏了 --build-arg GIT_SHA（CI 里是 build-images 的 build-args）"
    info "api 没带提交号（本机构建且没传 GIT_SHA），跳过提交号核对"
    return 0
  fi

  tag=$(setting TAG latest)
  case $tag in
    sha-*)
      tag=${tag#sha-}
      [ "${tag:0:7}" = "$served" ] || fail \
        "要部署的是 TAG=sha-$tag，线上 api 答的却是 $served" \
        "api 容器没换成这一版。看 bash prod.sh status 各容器的提交号"
      ;;
  esac
  [ -z "$label" ] || [ "${label:0:7}" = "$served" ] || fail \
    "api 镜像的 revision 标签是 ${label:0:7}，接口答的却是 $served" \
    "经 web 的 nginx 到达的不是这个 api 容器，或镜像的标签和内容不是同一次构建"

  web_commit=$(curl -s -m 5 "$base/version.json" | json_str commit || true)
  if [ -n "$web_commit" ] && [ "$web_commit" != "$served" ]; then
    fail \
      "前后端不是同一个提交：web 是 $web_commit，api 是 $served" \
      "多半是只拉到 / 只换了其中一个镜像。重跑 bash prod.sh pull 再 up；看 bash prod.sh status"
  fi
  ok "线上提交号 $served（api${web_commit:+ · web}${label:+ · 镜像标签} 一致）"
}

# ── build 时烙进镜像的提交号 ─────────────────────────────────────────────
# 显式给了 GIT_SHA 就用它；否则取仓库的 HEAD。
# 🔴 **工作区有没提交的改动时不烙**（输出空串 → 接口上是 commit: null）。那样构建出来的镜像，内容比 HEAD 多，
# 烙上 HEAD 的提交号等于让线上自称是一份它不是的源码 —— 「不知道」比「错的」好（#379 评审）。
# 未跟踪的文件也算：它们一样会被 COPY 进镜像
build_commit() {
  if [ -n "${GIT_SHA:-}" ]; then
    printf '%s\n' "$GIT_SHA"
    return 0
  fi
  local sha dirty
  sha=$(git -C "$project_dir" rev-parse HEAD 2>/dev/null || true)
  [ -n "$sha" ] || return 0
  dirty=$(git -C "$project_dir" status --porcelain 2>/dev/null || true)
  if [ -n "$dirty" ]; then
    warn "工作区有没提交的改动，这次构建不烙提交号（接口上会是 commit: null）" \
      "要烙就先提交，或显式指定：GIT_SHA=<提交号> bash prod.sh build"
    return 0
  fi
  printf '%s\n' "$sha"
}

# ── 分发 ─────────────────────────────────────────────────────────────────
require_docker
info "compose: $compose"

case $command in
  config)
    check_env_file
    dc config
    ;;
  # build 不挂 .env.server（构建期用不到它），所以不跑前置检查 —— 服务器上没有
  # 源码，这条会在 compose 找不到 ./apps/api 时**大声**失败，不是静默的
  #
  # 提交号从仓库里取了传给构建（compose 的 `args: GIT_SHA`），`/api/health/status` 和 `/version.json`
  # 才报得出 commit（#378）。
  build)
    GIT_SHA=$(build_commit)
    export GIT_SHA
    dc build
    ;;
  pull)
    check_env_file
    cmd_pull
    ;;
  up)
    check_env_file
    check_env_owner
    dc up -d
    probe_after_up
    ;;
  down) dc down ;;
  logs) dc logs -f --tail=200 ;;
  status) cmd_status ;;
  sync) cmd_sync "${2:-main}" ;;
esac
