# 独立容器构建 / Standalone Docker build

把后端单独打成一个容器镜像的做法（不含前端、不含依赖服务）。
开发环境请用仓库根的 `docker-compose.dev.yml` + `pnpm dev`，见
[根 README](../../../README.md)。

> 这份说明沿用自上游 fastapi-best-architecture，命令仍然有效。

## Docker

1. Make sure you're at the root of the project
2. Run the following Docker command to build container:

   ```shell
   docker build -f Dockerfile -t fba_backend_independent .
   ```

3. Start container

   Native boot needs to change `127.0.0.1` in `.env` to `host.docker.internal`

   ```shell
   docker run -d -p 8000:8000 --name fba_server fba_backend_independent
   ```
