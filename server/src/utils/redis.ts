import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
  enableReadyCheck: false,
  retryStrategy: (times) => Math.min(times * 50, 2000),
});

export default redis;
