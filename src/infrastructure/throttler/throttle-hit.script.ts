// One atomic rate-limit hit. It reproduces, step by step, what @nestjs/throttler's own in-memory
// storage does (ThrottlerStorageService.increment with no blockDuration), so the two can be compared
// result for result (test/integration/redis-throttler.integration-spec.ts does exactly that).
//
//   KEYS[1]  hits    ZSET   member = a unique id per hit, score = the instant that hit stops counting (ms)
//   KEYS[2]  window  STRING the instant the current window ends (ms); it only exists while the window does
//   ARGV[1]  ttl in ms      ARGV[2]  limit      ARGV[3]  a unique id for this hit
//
// Rules that matter:
//  - Time is `TIME` of the Redis server, read here. No client clock takes part, so instances whose
//    clocks disagree still agree on every window.
//  - Expired hits are trimmed on every call, and the TTL of the hits key is renewed on every call, so
//    a key cannot outlive its data. A blocked call adds nothing, so the set never holds more than
//    `limit` members.
//  - The window key is created with its own TTL and never renewed; absent means "a new window starts".
//  - Any failure inside the script is an error reply. The caller treats an error as "unknown", never
//    as "allowed".
//
// Returns { totalHits, timeToExpire (s), isBlocked (0|1), timeToBlockExpire (s) }.
export const THROTTLE_HIT_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local count = redis.call('ZCARD', KEYS[1])

local raw = redis.call('GET', KEYS[2])
local windowEnd = raw and tonumber(raw) or nil
if windowEnd == nil or windowEnd <= now then
  windowEnd = now + ttl
  redis.call('SET', KEYS[2], windowEnd, 'PX', ttl)
end
local timeToExpire = math.ceil((windowEnd - now) / 1000)

local blocked = count >= limit
local timeToBlockExpire = 0
if blocked then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  if #oldest > 0 then
    timeToBlockExpire = math.ceil((tonumber(oldest[2]) - now) / 1000)
  else
    timeToBlockExpire = timeToExpire
  end
else
  redis.call('ZADD', KEYS[1], now + ttl, ARGV[3])
end
redis.call('PEXPIRE', KEYS[1], ttl)

return { count + 1, timeToExpire, blocked and 1 or 0, timeToBlockExpire }
`;
