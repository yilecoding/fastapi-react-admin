import asyncio
import datetime
import secrets
import threading
import time

from dataclasses import dataclass

from backend.common.dataclasses import SnowflakeInfo
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.log import log
from backend.core.conf import settings
from backend.database.redis import RedisCli, redis_client
from backend.utils.timezone import timezone

_RENEW_NODE_LEASE = """
local current = redis.call('GET', KEYS[1])
if current == ARGV[1] then
    return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
if not current then
    local registered = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])
    if registered then
        return 2
    end
end
return 0
"""

_RELEASE_NODE_LEASE = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0
"""


@dataclass(frozen=True)
class SnowflakeConfig:
    """雪花算法配置类，采用 Twitter 原版 Snowflake 64 位 ID 位分配配置（通用标准）"""

    # 位分配
    WORKER_ID_BITS: int = 5
    DATACENTER_ID_BITS: int = 5
    SEQUENCE_BITS: int = 12

    # 最大值
    MAX_WORKER_ID: int = (1 << WORKER_ID_BITS) - 1  # 31
    MAX_DATACENTER_ID: int = (1 << DATACENTER_ID_BITS) - 1  # 31
    SEQUENCE_MASK: int = (1 << SEQUENCE_BITS) - 1  # 4095

    # 位移偏移
    WORKER_ID_SHIFT: int = SEQUENCE_BITS
    DATACENTER_ID_SHIFT: int = SEQUENCE_BITS + WORKER_ID_BITS
    TIMESTAMP_LEFT_SHIFT: int = SEQUENCE_BITS + WORKER_ID_BITS + DATACENTER_ID_BITS

    # 元年时间戳
    EPOCH: int = 1262275200000

    # 时钟回拨容忍阈值，应对 NTP 自动同步引起的正常回跳（非标准）
    CLOCK_BACKWARD_TOLERANCE_MS: int = 10_000


class SnowflakeNodeManager:
    """雪花算法节点管理器，负责从 Redis 分配和管理节点 ID"""

    def __init__(self, redis: RedisCli | None = None) -> None:
        """初始化节点管理器

        :param redis: 抢节点用的 Redis。默认是全局那个（按进程启动时的配置建的）；`fba init --auto`
            会在进程里改 Redis 配置、另建一个客户端，要把那个传进来，否则租约记到了旧的 Redis 上
        """
        self._redis = redis or redis_client
        self.datacenter_id: int | None = None
        self.worker_id: int | None = None
        self.node_redis_prefix: str = f'{settings.SNOWFLAKE_REDIS_PREFIX}:nodes'
        self._heartbeat_task: asyncio.Task | None = None
        self._node_token = secrets.token_hex(16)
        self._lease_valid = True
        self._lease_deadline: float | None = None

    @property
    def lease_valid(self) -> bool:
        """Redis 已确认当前进程仍持有节点租约。"""
        if self._lease_deadline is not None and time.monotonic() >= self._lease_deadline:
            self._lease_valid = False
        return self._lease_valid

    async def acquire_node_id(self) -> tuple[int, int]:
        """从 Redis 获取可用的 datacenter_id 和 worker_id"""
        occupied_nodes = set()
        async for key in self._redis.scan_iter(match=f'{self.node_redis_prefix}:*'):
            parts = key.split(':')
            if len(parts) >= 5:
                try:
                    datacenter_id = int(parts[-2])
                    worker_id = int(parts[-1])
                    occupied_nodes.add((datacenter_id, worker_id))
                except ValueError:
                    continue

        # 顺序查找第一个可用的 ID 组合
        for datacenter_id in range(SnowflakeConfig.MAX_DATACENTER_ID + 1):
            for worker_id in range(SnowflakeConfig.MAX_WORKER_ID + 1):
                if (datacenter_id, worker_id) not in occupied_nodes and await self._register(datacenter_id, worker_id):
                    return datacenter_id, worker_id

        raise errors.ServerError(msg=t('error.snowflake.no_node_available'))

    async def _register(self, datacenter_id: int, worker_id: int) -> bool:
        key = f'{self.node_redis_prefix}:{datacenter_id}:{worker_id}'
        request_started = time.monotonic()
        registered = await self._redis.set(key, self._node_token, nx=True, ex=settings.SNOWFLAKE_NODE_TTL_SECONDS)
        if registered:
            self._lease_deadline = request_started + settings.SNOWFLAKE_NODE_TTL_SECONDS
        return bool(registered)

    async def _renew_lease(self, key: str) -> int:
        """续期当前 token 的租约；key 丢失时尝试原子重占。"""
        request_started = time.monotonic()
        renewed = await self._redis.eval(
            _RENEW_NODE_LEASE,
            1,
            key,
            self._node_token,
            str(settings.SNOWFLAKE_NODE_TTL_SECONDS),
        )
        if renewed:
            self._lease_valid = True
            self._lease_deadline = request_started + settings.SNOWFLAKE_NODE_TTL_SECONDS
            if renewed == 2:
                log.warning(f'雪花算法节点租约丢失后已重新占位：key={key}')
            else:
                log.debug(f'雪花算法节点心跳成功：key={key}')
        else:
            self._lease_valid = False
            self._lease_deadline = None
            log.error(f'雪花算法节点租约已被其他进程占用，停止发号：key={key}')
        return renewed

    async def start_heartbeat(self, datacenter_id: int, worker_id: int) -> None:
        """启动节点心跳"""
        self.datacenter_id = datacenter_id
        self.worker_id = worker_id

        async def heartbeat() -> None:
            key = f'{self.node_redis_prefix}:{datacenter_id}:{worker_id}'
            while True:
                await asyncio.sleep(settings.SNOWFLAKE_HEARTBEAT_INTERVAL_SECONDS)
                try:
                    await self._renew_lease(key)
                except Exception as e:
                    self._lease_valid = False
                    log.error(f'雪花算法节点心跳任务失败：{e}')

        self._heartbeat_task = asyncio.create_task(heartbeat())

    async def release(self) -> None:
        """释放节点"""
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                log.debug(f'雪花算法节点心跳任务释放：datacenter_id={self.datacenter_id}, worker_id={self.worker_id}')

        if self.datacenter_id is not None and self.worker_id is not None:
            key = f'{self.node_redis_prefix}:{self.datacenter_id}:{self.worker_id}'
            await self._redis.eval(_RELEASE_NODE_LEASE, 1, key, self._node_token)


class Snowflake:
    """雪花算法类"""

    def __init__(self) -> None:
        """初始化雪花算法"""
        self.datacenter_id: int | None = None
        self.worker_id: int | None = None
        self.sequence: int = 0
        self.last_timestamp: int = -1

        self._lock = threading.Lock()
        self._initialized = False
        self._node_manager: SnowflakeNodeManager | None = None
        self._auto_allocated = False  # 标记是否由 Redis 自动分配 ID

    async def init(self, redis: RedisCli | None = None) -> None:
        """初始化雪花算法

        :param redis: 动态分配节点时用的 Redis，见 `SnowflakeNodeManager`
        """
        if self._initialized:
            return

        with self._lock:
            # 环境变量固定分配
            if settings.SNOWFLAKE_DATACENTER_ID is not None and settings.SNOWFLAKE_WORKER_ID is not None:
                self.datacenter_id = settings.SNOWFLAKE_DATACENTER_ID
                self.worker_id = settings.SNOWFLAKE_WORKER_ID
                log.debug(
                    f'雪花算法使用环境变量固定节点：datacenter_id={self.datacenter_id}, worker_id={self.worker_id}'
                )
            elif (settings.SNOWFLAKE_DATACENTER_ID is not None and settings.SNOWFLAKE_WORKER_ID is None) or (
                settings.SNOWFLAKE_DATACENTER_ID is None and settings.SNOWFLAKE_WORKER_ID is not None
            ):
                log.error('雪花算法 datacenter_id 和 worker_id 配置错误，只允许同时非 None 或同时为 None')
                raise errors.ServerError(msg=t('error.snowflake.config_failed'))
            else:
                # Redis 动态分配
                self._node_manager = SnowflakeNodeManager(redis)
                self.datacenter_id, self.worker_id = await self._node_manager.acquire_node_id()
                self._auto_allocated = True
                await self._node_manager.start_heartbeat(self.datacenter_id, self.worker_id)
                log.debug(
                    f'雪花算法使用 Redis 动态分配节点：datacenter_id={self.datacenter_id}, worker_id={self.worker_id}'
                )

            # 严格校验范围
            if not (0 <= self.datacenter_id <= SnowflakeConfig.MAX_DATACENTER_ID):
                log.error(f'雪花算法 datacenter_id 配置失败，必须在 0~{SnowflakeConfig.MAX_DATACENTER_ID} 之间')
                raise errors.ServerError(msg=t('error.snowflake.datacenter_config_failed'))
            if not (0 <= self.worker_id <= SnowflakeConfig.MAX_WORKER_ID):
                log.error(f'雪花算法 worker_id 配置失败，必须在 0~{SnowflakeConfig.MAX_WORKER_ID} 之间')
                raise errors.ServerError(msg=t('error.snowflake.worker_config_failed'))

            self._initialized = True

    async def shutdown(self) -> None:
        """释放 Redis 节点"""
        if self._node_manager and self._auto_allocated:
            await self._node_manager.release()

    @staticmethod
    def _current_ms() -> int:
        # 🔴 用系统时钟，不用 `timezone.now()`：两者在生产上一样，但测试会把 `timezone.now` 换成假时钟模拟时间流逝
        # （`test_scheduler_timing.py`）。发号器在假时钟下记住一个「未来」的时间戳，假时钟一撤，之后所有生成 ID 的地方
        # 都报「时钟回拨」—— #281 登记了定时任务表、改调度要写审计行之后，整套 pytest 在那个文件之后连环红了几百条
        return int(time.time() * 1000)

    def _till_next_ms(self, last_timestamp: int) -> int:
        """等待直到下一毫秒"""
        ts = self._current_ms()
        while ts <= last_timestamp:
            time.sleep(0.0001)
            ts = self._current_ms()
        return ts

    def generate(self) -> int:
        """生成雪花 ID"""
        if not self._initialized:
            raise errors.ServerError(msg=t('error.snowflake.generation_failed'))

        with self._lock:
            if self._auto_allocated and self._node_manager and not self._node_manager.lease_valid:
                raise errors.ServerError(msg=t('error.snowflake.generation_failed'))

            timestamp = self._current_ms()

            # 时钟回拨处理
            if timestamp < self.last_timestamp:
                back_ms = self.last_timestamp - timestamp
                if back_ms <= SnowflakeConfig.CLOCK_BACKWARD_TOLERANCE_MS:
                    log.warning(f'检测到时钟回拨 {back_ms} ms，等待恢复...')
                    timestamp = self._till_next_ms(self.last_timestamp)
                else:
                    raise errors.ServerError(msg=t('error.snowflake.clock_moved_backwards', ms=back_ms))

            # 同毫秒内序列号递增
            if timestamp == self.last_timestamp:
                self.sequence = (self.sequence + 1) & SnowflakeConfig.SEQUENCE_MASK
                if self.sequence == 0:
                    timestamp = self._till_next_ms(self.last_timestamp)
            else:
                self.sequence = 0

            self.last_timestamp = timestamp

            # 组合 64 位 ID
            return (
                ((timestamp - SnowflakeConfig.EPOCH) << SnowflakeConfig.TIMESTAMP_LEFT_SHIFT)
                | (self.datacenter_id << SnowflakeConfig.DATACENTER_ID_SHIFT)
                | (self.worker_id << SnowflakeConfig.WORKER_ID_SHIFT)
                | self.sequence
            )

    @staticmethod
    def parse(snowflake_id: int) -> SnowflakeInfo:
        """
        解析雪花 ID，获取其包含的详细信息

        :param snowflake_id: 雪花ID
        :return:
        """
        timestamp = (snowflake_id >> SnowflakeConfig.TIMESTAMP_LEFT_SHIFT) + SnowflakeConfig.EPOCH
        datacenter_id = (snowflake_id >> SnowflakeConfig.DATACENTER_ID_SHIFT) & SnowflakeConfig.MAX_DATACENTER_ID
        worker_id = (snowflake_id >> SnowflakeConfig.WORKER_ID_SHIFT) & SnowflakeConfig.MAX_WORKER_ID
        sequence = snowflake_id & SnowflakeConfig.SEQUENCE_MASK

        return SnowflakeInfo(
            timestamp=timestamp,
            datetime=timezone.to_str(datetime.datetime.fromtimestamp(timestamp / 1000, timezone.tz_info)),
            datacenter_id=datacenter_id,
            worker_id=worker_id,
            sequence=sequence,
        )


snowflake = Snowflake()
