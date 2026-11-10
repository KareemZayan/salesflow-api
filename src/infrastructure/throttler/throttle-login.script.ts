// One atomic decision for POST /auth/login: the per-IP limit AND the per-account (IP + email) limit
// together (ADR 0016, 15c.1). It exists because two separate counters cannot be both safe and bounded:
// account-first creates an account key for every email an IP tries even after the IP is over its limit;
// IP-first lets one account hammered by one user use up the budget of everybody behind the same NAT.
//
//   KEYS[1]  ip       ZSET  member = a unique id per admitted attempt, score = when it stops counting (ms)
//   KEYS[2]  account  ZSET  same shape, for this IP + email
//   ARGV[1]  ttl in ms   ARGV[2]  ip limit   ARGV[3]  account limit   ARGV[4]  a unique id
//
// Order, in three phases:
//   1. VALIDATE. Arguments and key types are checked first. Nothing is written, so a bad argument or a
//      key of the wrong type fails here and leaves no counter changed. (ZREMRANGEBYSCORE is a WRITE, so
//      trimming is not done here; live hits are counted with ZCOUNT / ZRANGEBYSCORE, which only read.)
//   2. DECIDE. IP first, then account:
//        ip count      >= ip limit      -> blocked by IP      (status 1)
//        account count >= account limit -> blocked by account (status 2)
//        otherwise                      -> admitted           (status 0)
//      A blocked request returns here having written NOTHING: it creates no key, adds no hit to either
//      set and, in particular, a request blocked by the account limit does not use up the IP's budget.
//   3. ADMIT. Only an admitted request writes: it trims expired hits, adds one hit to each set and
//      renews both TTLs. This is the only place a key can come into existence, so an IP creates at most
//      `ip limit` account keys per window, however many different emails it sends.
//
// Time is `TIME` of the Redis server, read once; no client clock takes part. A failure is an error
// reply (the caller treats it as "unknown", never as "allowed").
//
// Returns { status, totalHits, timeToExpire (s), timeToBlockExpire (s) }.
export const THROTTLE_LOGIN_SCRIPT = `
-- 1. VALIDATE (no writes)
local ttl = tonumber(ARGV[1])
local ipLimit = tonumber(ARGV[2])
local accountLimit = tonumber(ARGV[3])
local member = ARGV[4]
if ttl == nil or ttl < 1 or ttl ~= math.floor(ttl) then
  return redis.error_reply('ERR invalid ttl')
end
if ipLimit == nil or ipLimit < 0 or ipLimit ~= math.floor(ipLimit) then
  return redis.error_reply('ERR invalid ip limit')
end
if accountLimit == nil or accountLimit < 0 or accountLimit ~= math.floor(accountLimit) then
  return redis.error_reply('ERR invalid account limit')
end
if member == nil or member == '' then
  return redis.error_reply('ERR invalid member')
end
for i = 1, 2 do
  local kind = redis.call('TYPE', KEYS[i]).ok
  if kind ~= 'none' and kind ~= 'zset' then
    return redis.error_reply('WRONGTYPE Operation against a key holding the wrong kind of value')
  end
end

-- 2. DECIDE (reads only)
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local live = '(' .. string.format('%.0f', now)

local function liveCount(key)
  return redis.call('ZCOUNT', key, live, '+inf')
end
local function seconds(untilMs)
  return math.ceil((untilMs - now) / 1000)
end
local function secondsUntilOldestLeaves(key)
  local oldest = redis.call('ZRANGEBYSCORE', key, live, '+inf', 'WITHSCORES', 'LIMIT', 0, 1)
  if #oldest > 0 then
    return seconds(tonumber(oldest[2]))
  end
  return seconds(now + ttl)
end

local ipCount = liveCount(KEYS[1])
if ipCount >= ipLimit then
  local wait = secondsUntilOldestLeaves(KEYS[1])
  return { 1, ipCount + 1, wait, wait }
end

local accountCount = liveCount(KEYS[2])
if accountCount >= accountLimit then
  local wait = secondsUntilOldestLeaves(KEYS[2])
  return { 2, accountCount + 1, wait, wait }
end

-- 3. ADMIT (the only writes)
local timeToExpire = secondsUntilOldestLeaves(KEYS[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
redis.call('ZADD', KEYS[1], now + ttl, member)
redis.call('ZADD', KEYS[2], now + ttl, member)
redis.call('PEXPIRE', KEYS[1], ttl)
redis.call('PEXPIRE', KEYS[2], ttl)

return { 0, accountCount + 1, timeToExpire, 0 }
`;
