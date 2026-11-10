# ADR 0016: Hardening (Phase 15)

Status: in progress. 15a (database failure handling), 15b (required NODE_ENV, production guards,
no-store), 15c (rate-limit counters in Redis) and 15c.1 (auth throttling hardening) are implemented.
15d-15g append their sections here as they land (tenant isolation and the RLS decision, operations,
performance measurement).

Builds on [ADR 0002](0002-tenant-scoping.md) (tenant scoping), [ADR 0004](0004-users-admin.md) (the
advisory locks) and [ADR 0014](0014-audit-logs.md) (fail-closed audit writes).

## 15a. Database failures: what the API answers, and how the pool is sized

### Why

Before 15a, only `P2002`, `P2025` and `P2003` had a mapping. Everything else was `500 INTERNAL_ERROR`,
including a full connection pool, a deadlock and a lost database, none of which are bugs. Every write
path holds a connection inside a transaction while it waits for an advisory lock, so these are the
failures a loaded system actually produces. The pool and every timeout were also on library defaults
(`pg` waits for a free connection **forever**; Prisma's transaction limit is 5 s).

### What Prisma 7 + the pg adapter actually throw (observed, PostgreSQL 16)

Nothing below is assumed. `test/integration/prisma-failures.integration-spec.ts` provokes each case
against a real database and pins the shape, so a driver upgrade that changes one fails a test.

| Situation                                                                             | Thrown                                                                                                                                                                                                                                                                         | Notes                                                                                                                                                                          |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No free connection (plain query)                                                      | plain `Error`: `timeout exceeded when trying to connect`                                                                                                                                                                                                                       | **Not a Prisma error.** From `pg`.                                                                                                                                             |
| Transaction cannot start (`maxWait`)                                                  | `P2028`, `meta: {}`, "Unable to start a transaction in…"                                                                                                                                                                                                                       |                                                                                                                                                                                |
| Transaction ran past its limit                                                        | `P2028`, `meta.timeout` is a number                                                                                                                                                                                                                                            | Query-after-expiry and commit-after-expiry look the same; both are rolled back.                                                                                                |
| Use of a finished transaction client                                                  | `P2028`, `meta: {}`, "Transaction already closed"                                                                                                                                                                                                                              | A **code bug** (a leaked `tx`), not load.                                                                                                                                      |
| `statement_timeout` / `lock_timeout`                                                  | `P2010` (raw query) or `P2039` (model query); SQLSTATE `57014` / `55P03` in `meta.driverAdapterError.cause.originalCode`                                                                                                                                                       | The Prisma code depends on the call path, the SQLSTATE does not.                                                                                                               |
| Deadlock                                                                              | `P2010` (raw) or `P2034` (model); SQLSTATE `40P01`                                                                                                                                                                                                                             | `P2034` is **not** raised for raw queries.                                                                                                                                     |
| Serialization failure                                                                 | `P2034`, SQLSTATE `40001`                                                                                                                                                                                                                                                      |                                                                                                                                                                                |
| Database unreachable, single address / DNS failure                                    | `P1001` (model query, transaction start); **raw query: `P2010`** with cause `kind: DatabaseNotReachable` and no SQLSTATE                                                                                                                                                       | `UNAVAILABLE`. Found in 15b when an HTTP test returned 500.                                                                                                                    |
| Database unreachable, host with SEVERAL addresses (`localhost` = `::1` + `127.0.0.1`) | **model query:** known-request error, `code: 'ECONNREFUSED'`, `meta: { modelName }`. **raw query:** known-request error, `code: 'ECONNREFUSED'`, **no `meta`**. **transaction start:** a **bare `AggregateError`** (not a Prisma error), `code: 'ECONNREFUSED'`, empty message | `UNAVAILABLE` for all three. The `P2010` shape above is _not_ one of these three; an earlier version of this row mixed them up. Each of the four shapes has its own unit test. |
| Backend killed / idle-in-transaction kill                                             | plain `Error`: `Client has encountered a connection error…`                                                                                                                                                                                                                    | Pool recovers; the next query works.                                                                                                                                           |

### The mapping (`common/utils/database-failure.util.ts`, used by `AllExceptionsFilter`)

| Class            | Status | `code`                 | `Retry-After` | Why                                                                                 |
| ---------------- | ------ | ---------------------- | ------------- | ----------------------------------------------------------------------------------- |
| `BUSY`           | 503    | `DATABASE_BUSY`        | 2 s           | Nothing ran; capacity, not a fault. Waiting is the right answer.                    |
| `UNAVAILABLE`    | 503    | `DATABASE_UNAVAILABLE` | 2 s           | Nothing committed; retry after the database is back.                                |
| `TIMEOUT`        | 503    | `DATABASE_TIMEOUT`     | none          | Rolled back, but the same request may take as long again.                           |
| `WRITE_CONFLICT` | 409    | `WRITE_CONFLICT`       | none          | Deadlock/serialization victim, rolled back; an immediate retry is expected to pass. |

`P2028` is split by what it carries (`meta.timeout`, the "Unable to start" message), never mapped as a
whole. "Transaction already closed" and every code we did not observe (`P2024`, `P1002`, `P1008`,
`P1017`) deliberately stay `500`: guessing would hide bugs or lie to clients. Responses carry no driver
text; the cause is logged (the filter logs every 5xx with its stack).

None of these is an `HttpException`, so a domain error is never reinterpreted.

### Timeout semantics and ordering

| Setting (env)                       | Default | Enforced by                | Meaning                                                                    |
| ----------------------------------- | ------- | -------------------------- | -------------------------------------------------------------------------- |
| `DB_POOL_ACQUIRE_TIMEOUT_MS`        | 5000    | pg pool + Prisma `maxWait` | Longest a request waits for a connection, then `DATABASE_BUSY`.            |
| `DB_STATEMENT_TIMEOUT_MS`           | 8000    | PostgreSQL                 | One statement, **including a wait for a lock**.                            |
| `DB_TRANSACTION_TIMEOUT_MS`         | 10000   | Prisma (client)            | Whole interactive transaction.                                             |
| `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | 30000   | PostgreSQL                 | Connection idle inside an open transaction (a leaked one keeps its locks). |

Required order, enforced at startup: **statement < transaction < idle-in-transaction**.

The first inequality comes from a measurement, not a preference. A transaction blocked on an advisory
lock was given a 300 ms transaction limit and a holder that kept the lock for 2.5 s: Prisma reported
the timeout after **2.3 s**, and the connection came back only then. Prisma's limit is checked by the
client and cannot interrupt a statement that PostgreSQL is waiting on. With a server-side
`statement_timeout` of 400 ms the same wait failed at the limit and the connection returned at once.
So the statement limit is what bounds a lock wait, and it must fire first. Both cases are pinned in
the integration spec.

`idle > transaction` makes Prisma's own limit fire first in normal cases; the server limit is only the
backstop for a connection that stopped talking.

Release is verified, not assumed: with a pool of one connection, after an expired transaction, a
statement timeout, a deadlock victim and a throwing callback, the next query succeeds, no advisory lock
remains held and no session is left `idle in transaction`. An expired transaction is rolled back
completely, including when the limit is hit at commit.

Not changed: `AUDIT_RETENTION_TX_TIMEOUT_MS` (120 s) still overrides the transaction limit for the
retention job. Its statements are 1,000-row batches, far below the 8 s statement limit.

### Pool sizing (`DB_POOL_MAX`)

Facts: the compose PostgreSQL 16 has `max_connections = 100` and `superuser_reserved_connections = 3`
(read from the running container). One API process owns one pool. BullMQ talks to Redis, not
PostgreSQL.

```
reserve   = 10      3 superuser slots + migrate/seed/org:create at deploy (1-2) + operators and monitoring
budget    = max_connections - reserve = 100 - 10 = 90
pool      = floor(budget / peak_instances)
```

`peak_instances` counts every process that opens a pool, including the extra instance a rolling
deploy starts before the old one stops, and any separate worker process.

| Peak instances  | `DB_POOL_MAX` ceiling | Connections used at the default (10)                |
| --------------- | --------------------- | --------------------------------------------------- |
| 1               | 90                    | 10                                                  |
| 3 (2 + 1 surge) | 30                    | 30                                                  |
| 9               | 10                    | 90 (the default is exactly the limit)               |
| 12              | 7                     | needs 7, or raise `max_connections` / add PgBouncer |

The default of 10 (the `pg` default, so no behaviour change) is safe up to 9 peak instances. It is not
tuned to a measured load: a rule of thumb for a first estimate is `connections ≈ requests/s × average
time a request holds a connection`, so 100 requests/s holding 20 ms each needs about 2. **No load test
has been run; revisit the number with a measured p95 before production.** If `max_connections` is
raised, raise the budget, not the reserve.

### Residual risks (accepted, not fixed here)

1. **One organization can starve the pool.** Writes of one organization queue on its advisory lock, and
   each waiter holds a connection. The wait is now bounded (8 s statement limit; 5 s for everyone else
   to give up with `503`), but a burst on one organization can still use the whole pool for those
   seconds. A per-organization concurrency limit would fix it; it is a design change, not a setting.
2. **Workers share the API pool.** A process with `QUEUE_WORKERS_ENABLED=true` can run up to 41 jobs at
   once (8 queues x concurrency 5, plus sweeps at 1) against a pool of 10. A job that waits more than
   5 s for a connection fails and is retried with backoff, so nothing is lost, but jobs can slow HTTP
   traffic. For production, run workers as their own deployment (`QUEUE_WORKERS_ENABLED=false` on the
   API instances) and count them in `peak_instances`.
3. **Report queries are not measured at volume** (ADR 0015). A report statement longer than 8 s is now
   cancelled with `503 DATABASE_TIMEOUT` instead of running on; the limit is configurable.
4. **Error detection of two cases relies on `pg` message text** (`timeout exceeded when trying to
connect`, `Client has encountered a connection error…`) because `pg` gives them no code. The
   integration spec fails if either text changes.
5. **A client that retries a `WRITE_CONFLICT` must be idempotent-safe**: the transaction was rolled
   back, so a retry is correct, but the API does not retry on the client's behalf.

### Tests

- Unit: `database-failure.util.spec.ts` (every shape, plus the cases that must NOT be classified),
  `all-exceptions.filter.spec.ts` (status, code, `Retry-After`, no driver text, `HttpException`
  untouched), `database-options.spec.ts`, `validate-env.spec.ts` (defaults, ordering rules, bounds).
- Integration (real PostgreSQL): `prisma-failures.integration-spec.ts`, 18 cases, covering every row of
  the observation table, the lock-wait finding, and connection/lock release after each failure kind.

## 15b. Required `NODE_ENV`, production guards, `no-store`

### `NODE_ENV` has no default

`NODE_ENV` used to default to `development`. Everything that distinguishes production hangs on it:
Swagger is mounted unless it is `production`, the Bull Board guard, the pino transport, the seed's
refusal of the placeholder password and of demo data. A deployment that simply forgot the variable
therefore ran as development with every guard off, without a single message. It is now **required** and
must be exactly `development`, `test` or `production` (`Production`, `prod`, `staging`, an empty string
all fail). The error says which of the two it is: "is required; set it to ..." versus "must be one of ...".
The same rule applies to the seed / `org:create` environment (`prisma/seed/seed-env.ts`), which had its
own copy of the default and the same production guards.

Consequences, all checked: the Docker image sets `NODE_ENV=production` (Dockerfile) and the dev
override sets `development`; `.env.example` sets it; the unit, integration and e2e runs get a valid value (Vitest supplies `test`; the e2e and integration
configs also load `.env`, which says `development`), so they need no change.

### Settings that stop the application (production only)

| Setting               | Rule                                     | Why                                                                                                                                            |
| --------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `REDIS_PASSWORD`      | non-empty after trimming                 | Redis holds every organization's queued job payloads and the report cache. An unauthenticated Redis is only acceptable on a developer machine. |
| `QUEUE_BOARD_ENABLED` | must not be `true` (unchanged, ADR 0011) | The board has no authentication.                                                                                                               |

Validation reports every problem in one message, not one per restart. Development and test are
unchanged: no password needed.

**Cost:** the prod-like local run (`docker compose -f docker-compose.yml up`) now needs `REDIS_PASSWORD`
in `.env`, as it already needed a real `SEED_ADMIN_PASSWORD`. Documented in `.env.example` and the README.

### Settings that only warn (production only)

`TRUST_PROXY=false` and an empty `CORS_ORIGINS` are both legitimate (an API reached directly; a
deployment with no browser client), so refusing to start would be wrong. They are forgotten more often
than they are chosen, though, so `configureApp` logs one warning each at startup
(`config/production-warnings.ts`, a pure function). They are silent in development and test, and when
set. `TRUST_PROXY=true` (every hop trusted) was added in 15c; see the 15c section.

### `Cache-Control: no-store`

Every response under the API prefix, errors included, carries `Cache-Control: no-store`: login and
refresh responses hold tokens, the rest holds tenant data. It is a middleware in `configureApp`, so it
applies before routing (a 404 or a rejected request gets it too).

Deliberately **not** covered: `/health` and `/health/ready` (outside the prefix), Swagger (development
only), and the Bull Board UI (development only, mounted under the prefix but HTML and static assets
rather than API data). The match is by whole path segment, so `/api/v1x/...` is not under the prefix and
`/api/v1/queues-lookalike` is. Mutation-checked: with the middleware removed, the six API cases fail and
the five "not ours" cases still pass.

### HTTP-level database failure tests

`test/e2e/database-failures.e2e-spec.ts` sends real requests and checks status, `Retry-After` and body,
with nothing mocked: database unreachable (503 `DATABASE_UNAVAILABLE`, `Retry-After: 2`, no host or
driver text in the body), pool exhausted (503 `DATABASE_BUSY`, `Retry-After: 2`, and the next request
succeeds), and a request stuck behind an organization lock (503 `DATABASE_TIMEOUT`, **no** `Retry-After`,
the change rolled back, the same request succeeding once the lock is free).

This test found a real gap in 15a: the unreachable case answered 500. The 15a integration spec had used
`127.0.0.1`, which Prisma reports as `P1001`; the test app used `localhost`, which resolves to two
addresses and is reported differently (see the corrected table above). The classifier was extended by
exactly those observed shapes, each pinned in the unit and integration specs. Timeout values and the
other mappings are unchanged.

### Tests

- `validate-env.spec.ts`: missing / unsupported `NODE_ENV`, the production Redis password rule
  (missing, empty, whitespace), development and test unaffected, several production problems reported
  together. `test/unit/seed-env.spec.ts`: the same for the seed.
- `production-warnings.spec.ts`: each warning, both, none when set, none outside production.
- `production-config.e2e-spec.ts` (real application build): production without a Redis password does not
  start; a correct production starts with no warnings and Swagger off; each warning appears alone and
  together; development and test start without noise.
- `cache-control.e2e-spec.ts`, plus a Bull Board case in `queue-board.e2e-spec.ts`.
- A missing `NODE_ENV` is tested at `validateEnv` only: `ConfigModule` also reads `.env`, so deleting the
  variable in an app-level test would silently fall back to the developer's file.

## 15c. Rate-limit counters in Redis

### Why

The limiter kept its counters in the memory of each API process. With N instances a client got N times
the allowed login attempts, and a restart gave every counter back. The counters now live in Redis
(`THROTTLE_STORAGE=redis`, the default) and are shared. No package was added: the storage is ours, on the
`ioredis` dependency that already exists.

### Finding: the library default is a lockout, not a window (a behaviour change, flagged for review)

`@nestjs/throttler` 6.7.1 has two behaviours in one storage, chosen by `blockDuration`. The guard computes
it as `blockDuration ?? ttl`. We never configured it, so **production has been running the blocking
branch with `blockDuration = ttl`**: once a client passes the limit it is blocked for a further full
window, whether or not its old hits have expired. The approved design here is a sliding window, and
the first end-to-end run failed on every request ("does not support blockDuration") because the guard was
handing the storage the TTL. The fix is to say `blockDuration: 0` on both throttlers, which selects the
non-blocking, sliding-window branch in Redis **and in memory mode** (same options, so development matches
production). Pinned by `throttler.options.spec.ts`, which drives the real `ThrottlerGuard` and shows it
sends 0 with our options and the TTL without them. Startup fails if a throttler does not say 0 (an unset
value is the dangerous case); the storage also refuses a `blockDuration > 0` at request time (a route-level
`@Throttle` override).

What changes for clients: after the limit is reached a client waits until its _oldest_ hit leaves the window
(at most one window), not a full extra window. The sustained allowance is the same (`limit` per window).
If a lockout is preferred, the Lua script needs a block branch; that is a decision for the owner.

### Algorithm (`throttle-hit.script.ts`)

One Lua script per hit, so it is atomic. Two keys per tracker: a sorted set of the hits (score = the instant
each stops counting) and a window key (the instant the current window ends, with its own TTL). It returns
the same `{ totalHits, timeToExpire, isBlocked, timeToBlockExpire }` as the library in-memory storage,
step for step, including the hit at `limit + 1`. A blocked hit adds nothing, so a set never holds more than
`limit` members. Expired hits are trimmed and the TTL renewed on **every** call, so no key outlives its data
(tested with a real scan: every throttle key has a TTL, and none is left after the window).

**Time comes from Redis (`TIME`) inside the script.** No client clock takes part, so instances whose clocks
disagree still agree. Tested with two instances whose `Date.now()` differs by two hours, and
mutation-checked (a script that takes the client time fails two tests).

### What happens when Redis cannot be consulted

| Throttler                                                                                                                                   | Redis down, slow, script error, or a malformed reply                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth` (login, refresh, change-password, **logout**; see 15c.1: login has its own combined limiter now and logout is no longer fail-closed) | **Fail closed.** `503`, code `THROTTLE_UNAVAILABLE` (its own code, not `DATABASE_UNAVAILABLE`), `Retry-After: 5`, standard body with `requestId`, no mention of Redis. The request never reaches the handler. |
| `default` (everything else)                                                                                                                 | The library in-memory limiter of this instance, same limit. **Never unlimited, but N times weaker with N instances** until Redis is back. Documented as accepted.                                             |

Consistent with ADR 0014: a security control that cannot run stops the operation. The cost is that nobody can
log in during a Redis outage (readiness reports not-ready then anyway). Any error is a failure: a script error
or an unexpected reply is never read as "allowed" (tested with a poisoned key against real Redis).

**Circuit breaker.** One Redis round trip is made per throttled request, bounded at 250 ms. After 3
consecutive failures the breaker opens for 5 s: requests are answered at once with no command sent (a slow
Redis would otherwise add 250 ms to every request). After the window exactly one request probes Redis; the
others still fail fast until it answers. A failed probe re-opens it. The breaker clock is monotonic
(`performance.now()`); it is never used for a rate-limit decision.

**Observability.** The outage is logged once (first failure) and so is the recovery, with the number of
requests refused with `THROTTLE_UNAVAILABLE` during the outage; `getStats()` keeps the running totals
(`rejectedUnavailable`, `servedByFallback`). There is no metrics system in the project, so the counter is
in-process and in the log line. `/health/ready` includes a `throttle` check made through the storage own
connection (a real PING, or "down" while the breaker is open). It is not derived from the BullMQ ping or the
cache connection, so a throttle outage cannot hide behind a healthy queue, and the fail-open cache connection
plays no part in it.

### Keys and Redis settings

- `<QUEUE_PREFIX>:throttle:hits:<hash>` and `<QUEUE_PREFIX>:throttle:window:<hash>`. BullMQ keeps
  `<prefix>:<queue>:...`; a unit test fails if a queue is ever named `throttle` or `cache`, and an integration
  test creates a real queue next to throttle keys and checks the two namespaces never overlap.
- `<hash>` is the SHA-256 the guard computes from route, throttler and tracker. **No email address and no IP
  is stored**: checked by scanning every key and member after logins with a known email and IP.
- The connection options (host, port, password, prefix, fail-fast) are one function,
  `failFastRedisOptions`, shared by the cache and the throttle storage; BullMQ reads the same
  `AppConfig.redis`. The throttle storage still has a connection of its own.
- At startup the API warns (never fails) if `maxmemory-policy` is not `noeviction`: an evicting Redis can
  drop a counter early. It skips the check silently if Redis is down or refuses `CONFIG`.

### THROTTLE_STORAGE

`redis` (default) or `memory`. `memory` is for development and tests and is **refused in production**
(validation). The e2e default is `memory` because its Redis is unreachable on purpose; the throttling
suites opt in with `createTestApp({ throttle })` and use the real Redis.

### Residual risks and upgrade paths

1. **Memory.** The window holds up to `limit` members per tracker (about 100 per active IP for the default
   throttler). Not measured. Upgrade path: a fixed-window counter (one integer per tracker) is O(1) but
   allows up to twice the limit across a window boundary.
2. **Not Redis Cluster.** The two keys of a hit are not hash-tagged; a cluster would need that.
3. **The fallback is N times weaker** during an outage (default throttler only).
4. **Login is unavailable during a Redis outage** by design (auth fails closed).
5. **A very slow Redis** costs at most 3 x 250 ms of waiting per instance before the breaker opens.
6. **The first requests after a cold start** can meet a connection that is not ready yet (no offline
   queue). `onModuleInit` waits up to 1 s for the connection before the application accepts traffic; after
   that they are treated like any failure.

### `TRUST_PROXY=true` warning

In production the API warns that `true` trusts every `X-Forwarded-For` hop: a client can forge it to bypass
rate limiting and to write a fake IP into the audit log, and it says to set the exact number of hops. Hop
counts are supported (`TRUST_PROXY=1` parses to the number 1, which Express treats as one hop), so no
follow-up is needed.

### Tests

- Unit: storage with a fake Redis (failure modes, breaker transitions with an injected clock, logs once,
  counters, probe, eviction check), options and the real guard, filter and exception, health indicator, env
  rules, `redis-namespaces`. The storage tests were mutation-checked (fail-closed off: 15 failures; breaker
  fast path off: 5; breaker never opening: 6).
- Integration (real Redis): parity with the library in-memory storage over five sequences (different limits
  and windows, hits just before and after the window ends, the hit at `limit + 1`), and every test also
  asserts that no request silently used the fallback; atomicity (100 concurrent hits, limit 10, one and four
  connections: exactly 10 pass); clock skew; TTL on every key; no BullMQ collision; a poisoned key.
- E2E: two apps on one Redis share a limit; no PII in any key; Redis down (auth 503, others limited,
  readiness down, refusals counted); a stalled Redis through a TCP proxy (auth fails after 250 ms three
  times, then fast; the breaker opens; it closes again by itself; one outage line, one recovery line);
  `auth-throttle` now runs on Redis; production refuses `memory`.
- Real-time parity cannot hit the window boundary to the millisecond; it tests 100 ms either side.

## 15c.1. Auth throttling hardening

Follow-up to 15c, found in its post-merge review. The merged 15c code and history are unchanged; this
changes how the login route is limited and corrects one claim in the 15c section above (its route
list omitted `logout`).

### Three problems, three fixes

1. **IPv6 rotation.** The library default tracker groups IPv6 clients by /64; our own auth tracker used the
   raw `req.ip`. A customer owns 2^64 addresses, so rotating through them gave a fresh bucket for every
   guess at one account. `clientIp()` now applies the library `normalizeIp(ip, 64)` for every throttler
   that uses our trackers, and the same 64 is passed to the module as `ipv6SubnetPrefix`
   (`IPV6_SUBNET_PREFIX`), so the default tracker and ours cannot disagree. IPv4 is unchanged; an
   IPv4-mapped IPv6 address (`::ffff:1.2.3.4`, what a dual-stack socket reports) is read as the IPv4 address.
2. **No limit per IP on login.** The only login bucket was per IP + email, so one IP could try any number of
   different accounts: unlimited password spraying, and an Argon2 verification per attempt (unknown emails
   take the dummy-hash path, so they cost the same). It also let one IP create a Redis key per email.
3. **Logout failed closed.** `logout` carried `@AuthThrottle()`, so during a Redis outage nobody could end a
   session. It now has no marker and runs on `default` (below).

### The login limiter: one atomic decision

Two separate counters cannot be both bounded and fair, and the first attempt at the design showed why:

- **account first, then IP:** an IP over its limit still creates an account key for every new email before
  being refused, so Redis keys are not bounded;
- **IP first, then account:** every request, including ones the account limit will refuse, spends the IP
  budget, so one hammered account (or one bot) locks everybody behind a shared NAT out.

So login has one throttler, `login`, and one Lua operation (`throttle-login.script.ts`) that decides both
limits together. Phases:

1. **Validate, no writes:** every argument and both key types. A bad argument or a wrong-typed key fails
   here and changes nothing.
2. **Decide, reads only:** live hits are counted with `ZCOUNT` / `ZRANGEBYSCORE`. `ZREMRANGEBYSCORE` is a
   write, so trimming is _not_ done here. First the IP (`count >= THROTTLE_AUTH_IP_LIMIT` -> refused by the
   IP), then the account (`count >= THROTTLE_AUTH_LIMIT` -> refused by the account).
3. **Admit, the only writes:** trim expired hits, add one hit to the IP set and one to the account set, renew
   both TTLs.

Consequences, each covered by a test against a real Redis:

| Situation                      | Result   | IP budget spent | Key created             |
| ------------------------------ | -------- | --------------- | ----------------------- |
| IP at its limit                | 429      | no              | **none**                |
| account at its limit, IP under | 429      | **no**          | **none**                |
| both allow                     | proceeds | yes, 1          | at most one account key |

- **Bounded keys.** A key can only come into existence in the admit phase, and an IP admits at most
  `THROTTLE_AUTH_IP_LIMIT` attempts per window, so one IP creates at most that many account keys per window
  plus one IP key, however many emails it sends. 5,000 different emails from one IP leave exactly 1 + 120
  keys; 5,000 more leave the key set (and the IP set) byte for byte identical.
- **Shared NAT.** Hammering one account costs the IP only `THROTTLE_AUTH_LIMIT` of its budget, so the other
  users behind that address keep the rest. Residual: someone behind the same address who sends
  `THROTTLE_AUTH_IP_LIMIT` _different_ emails a minute exhausts the budget for everybody; any per-IP limit
  has that property. Counting only failed logins would soften it, but needs a post-handler hook; deferred.
- **Account isolation.** The account bucket is `sha256(<normalized ip>|<normalized email>)`, never the email
  alone: the same email from another IP is another bucket, so an attacker cannot lock a victim out from the
  victim's own IP, and several IPs against one account each get their own allowance (each still bounded by
  its own IP limit). No global per-account ceiling, by decision: it would let a distributed attacker lock
  the victim out.
- **No partial state.** Redis scripts do not roll back, so every check that can fail comes before the first
  write; a refused request performs no write at all (tested: expired hits are not trimmed and no TTL is
  renewed by a refusal). Writes that follow are on keys already type-checked, with validated arguments; the
  only way left to fail mid-way is Redis running out of memory, which fails the login closed.
- **Concurrency.** One script is one atomic step, so there is no gap between "check" and "count": 1,000
  parallel attempts on one account over four connections admit exactly 10; 1,000 parallel different emails
  admit exactly 120 and create exactly 120 account keys; with a mix, the hits in the IP set equal the sum
  of the hits in the account sets (an admission never adds one without the other).
- **Time** is Redis `TIME`, read once; no client clock takes part (tested with clocks an hour apart).
- **One Redis call per login** (the two limits are decided together).

Keys: `<prefix>:throttle:login:ip:<sha256>` and `<prefix>:throttle:login:account:<sha256>`, each with a TTL.
No address and no email is stored; both are hashed inside the storage, which receives them as
`<ip>|<email>` (split at the first `|`: an address never contains one, an email may).

### Limits

| Setting                  | Default | Meaning                                                             |
| ------------------------ | ------- | ------------------------------------------------------------------- |
| `THROTTLE_AUTH_LIMIT`    | 10      | attempts per IP + email per window (unchanged)                      |
| `THROTTLE_AUTH_IP_LIMIT` | **120** | attempts per client IP (an IPv6 /64) per window, whatever the email |

Startup requires the IP limit to be at least the account limit (otherwise the account limit could never be
reached). Counts are of admitted attempts, successful or not. 120 is above what an office logging in
together needs and about equal to the general per-IP limit (100); a mobile carrier's shared IPv4 may need
more. It is a setting, not a constant.

### Which route runs what

| Route                        | Throttler          | Tracker | If Redis fails                             |
| ---------------------------- | ------------------ | ------- | ------------------------------------------ |
| `login`                      | `login` (combined) | `<ip>   | <email>`                                   | **503** `THROTTLE_UNAVAILABLE`, fail closed, no fallback |
| `refresh`, `change-password` | `auth` (unchanged) | `ip`    | 503, fail closed                           |
| `logout`                     | `default`          | `ip`    | per-instance limiter: works, still limited |
| everything else              | `default`          | `ip`    | per-instance limiter                       |

A route runs exactly one throttler. `FAIL_CLOSED_THROTTLERS` is `{ auth, login }`; `default` is deliberately
absent. Refresh and change-password were not changed (still per IP, per route, 10 per window), which is
tight for a very large office behind one address; flagged, not touched.

**Visible change:** the 429 header for login is now `Retry-After-login` (it was `Retry-After-auth`); the
header is named after the throttler. Nothing consumes it yet.

**Memory mode** (`THROTTLE_STORAGE=memory`, development and tests only, refused in production): the library
in-memory storage has no combined operation, so login has only the per-account limit there. The IP limit is
tested against Redis.

### Failure and recovery

Unchanged from 15c: any Redis problem is a failure; 3 in a row open the breaker for 5 s; one request then
probes; the outage and the recovery are each logged once. For login a failure is a `503`; for logout nothing
changes, because it never depended on Redis. A malformed `<ip>|<email>` key (a bug in the tracker) is a plain
error, not a Redis failure: it does not move the breaker and is never read as "allowed". Tested: dead
Redis, stalled Redis (login fails fast once the breaker is open, logout answers `204` in the middle of the
outage, and the session it ended is really gone after recovery).

### Tests

- Unit: trackers (IPv4, `::ffff:`, /64, zone id, missing address, the `|` separator), the storage's login
  path with a fake client (hashed keys, account isolation, reply validation, breaker, no fallback,
  malformed key), the script's write ordering on its source, the options and the route-to-throttler
  mapping through the real `ThrottlerGuard` and the real `AuthController` decorators, env rules.
- Integration (real Redis, 30 tests): cardinality (5,000 emails; 5,000 more with the key set unchanged;
  three IPs; a smaller limit), concurrency on one and four connections, shared-NAT budget, Lua safety
  (wrong-typed keys, invalid arguments, no write on refusal), a randomized comparison against a reference
  model, expiry, clock skew, namespaces next to plain counters and BullMQ. Mutation-checked: creating the
  account key before the IP check fails 12 tests, spending IP budget on an account refusal 7, trimming
  during the decision 1, scoping accounts by email alone 4.
- E2E (20 tests): IP cut-off with `Retry-After-login`, no new keys after the cut-off, /64 rotation, IPv4
  and IPv4-mapped addresses, several IPs against one account, shared NAT, valid login unchanged, non-string
  emails, no PII in Redis, dead and stalled Redis, logout during both.
