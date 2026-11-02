// Shared by every entity with a status lifecycle (leads now; deals and tasks later): a transition
// map decides what is allowed, and the write is a compare-and-set on the status that was just read.

// Allowed targets per status. Typed as a Record so a new enum value fails typecheck until it has an
// entry (a terminal status maps to `[]`).
export type TransitionMap<S extends string> = Readonly<Record<S, readonly S[]>>;

export function isTransitionAllowed<S extends string>(
  map: TransitionMap<S>,
  from: S,
  to: S,
): boolean {
  return map[from].includes(to);
}

export interface StatusTransition<S extends string, R> {
  map: TransitionMap<S>;
  to: S;
  // Reads the record WITH the caller's visibility. `null` = no such record for this caller. A hidden
  // record must never be told apart from a missing one, so every lookup here respects visibility.
  read: () => Promise<{ status: S } | null>;
  // The compare-and-set: ONE conditional update whose where carries `status = from` (and the
  // visibility). `null` = it matched nothing.
  write: (from: S) => Promise<R | null>;
  notFound: () => Error;
  // `to` is not reachable from `from` (this includes `from === to`).
  rejected: (from: S, to: S) => Error;
  // The status moved between our read and our write; `actual` is what it is now.
  changedConcurrently: (actual: S, to: S) => Error;
}

// The `from` is always the status the SERVER just read, never something the client sends. If another
// request changes the status between the read and the write, the conditional update matches nothing
// and the caller gets a conflict instead of a transition computed from stale data. No lock is needed:
// the write is a single atomic statement.
export async function applyStatusTransition<S extends string, R>(
  transition: StatusTransition<S, R>,
): Promise<R> {
  const { map, to, read, write, notFound, rejected, changedConcurrently } = transition;

  const current = await read();
  if (!current) throw notFound();
  if (!isTransitionAllowed(map, current.status, to)) throw rejected(current.status, to);

  const written = await write(current.status);
  if (written) return written;

  // Lost the race (or the record was hidden, reassigned or deleted meanwhile): look again, with the
  // same visibility, to say which.
  const latest = await read();
  if (!latest) throw notFound();
  throw changedConcurrently(latest.status, to);
}
