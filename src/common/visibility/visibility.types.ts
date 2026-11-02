// Which owners' records the caller may see. `all` is the admin case; otherwise a closed list of
// user ids (always contains the caller).
export type VisibilityScope = { kind: 'all' } | { kind: 'owners'; ownerIds: readonly string[] };
