# ADR 0001 — API response format

- Status: accepted (Phase 5, 2026-10-31)

## Decision

No global response envelope. Each endpoint returns exactly what its status code implies:

| Case            | Status  | Body                                                                         |
| --------------- | ------- | ---------------------------------------------------------------------------- |
| Single resource | 200/201 | The resource DTO itself                                                      |
| Offset list     | 200     | `{ data: T[], meta: { page, limit, total, totalPages } }`                    |
| Cursor list     | 200     | `{ data: T[], meta: { limit, nextCursor } }` (`null` = last)                 |
| Delete          | 204     | Empty                                                                        |
| Error           | 4xx/5xx | `{ statusCode, error, message, code, path, timestamp, requestId, details? }` |

`code` is a stable constant from `common/constants/error-codes.ts` (clients translate it); `details` carries per-field validation errors or health-probe results.

## Why

- Swagger types stay exact (`UserDto`, not `Envelope<UserDto>`), and a future generated client is simpler.
- HTTP status already says success or failure; a wrapper repeats it.
- Lists are the only place that needs extra metadata, so only they get `{ data, meta }`.

## Consequences

- Errors are produced in one place, `AllExceptionsFilter`. Business errors extend `DomainException(code, message, status)`.
- Offset pagination for ordinary lists; cursor pagination for append-heavy tables (activities, audit logs).
