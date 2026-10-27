import { SQL } from "bun";

/**
 * CB-112：`sweep()` / `reclaimStuckRuns()` 按设计扫全库所有用户的到点任务（生产上就该这样），
 * 所以两个测试进程同时跑时，A 进程的扫描会用 A 的假依赖把 B 刚造的任务发掉，B 的断言就落空。
 * 光换成独立 id 不够：凡是调用扫描的数据库测试套件，在整个套件期间持有同一把 Postgres 会话级
 * advisory lock，跨进程串行；锁随连接关闭自动释放，进程崩了也不会卡住别人。
 */
const SCHEDULE_SWEEP_TEST_LOCK = 4_812_112;

export async function holdScheduleSweepLock(
  url: string,
): Promise<() => Promise<void>> {
  const conn = new SQL({ url, max: 1 });
  await conn.unsafe("SELECT pg_advisory_lock($1)", [SCHEDULE_SWEEP_TEST_LOCK]);
  return async () => {
    await conn
      .unsafe("SELECT pg_advisory_unlock($1)", [SCHEDULE_SWEEP_TEST_LOCK])
      .catch(() => {});
    await conn.close();
  };
}
