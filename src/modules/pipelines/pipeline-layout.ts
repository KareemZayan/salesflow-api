// Pure position arithmetic for a pipeline's stages. Positions are 1..n in board order: the open
// stages (in their own order), then Won, then Lost. There is no unique constraint on
// (pipelineId, position) in the database, so a rewrite never needs temporary values; it runs in
// ONE transaction under the exclusive pipeline lock, which is what makes it atomic for readers.
// (If such a constraint is ever added it must be DEFERRABLE, or the rewrite must go through
// offset positions first.)
export interface LayoutStage {
  id: string;
  position: number;
  isWon: boolean;
  isLost: boolean;
}

export function splitStages<T extends LayoutStage>(
  stages: readonly T[],
): { open: T[]; won: T | undefined; lost: T | undefined } {
  const sorted = [...stages].sort((a, b) => a.position - b.position);
  return {
    open: sorted.filter((stage) => !stage.isWon && !stage.isLost),
    won: sorted.find((stage) => stage.isWon),
    lost: sorted.find((stage) => stage.isLost),
  };
}

// Final board order for the given open stages (the caller decides their order).
export function boardOrder<T extends LayoutStage>(
  open: readonly T[],
  won: T | undefined,
  lost: T | undefined,
): T[] {
  return [...open, ...(won ? [won] : []), ...(lost ? [lost] : [])];
}

// Only the stages whose position actually changes, so an unchanged board writes nothing.
export function positionChanges(ordered: readonly { id: string; position: number }[]) {
  return ordered
    .map((stage, index) => ({ id: stage.id, from: stage.position, position: index + 1 }))
    .filter((change) => change.from !== change.position)
    .map(({ id, position }) => ({ id, position }));
}
