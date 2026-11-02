import { LayoutStage, boardOrder, positionChanges, splitStages } from './pipeline-layout';

const stage = (id: string, position: number, kind?: 'won' | 'lost'): LayoutStage => ({
  id,
  position,
  isWon: kind === 'won',
  isLost: kind === 'lost',
});

describe('pipeline layout', () => {
  const stages = [stage('lost', 5, 'lost'), stage('b', 2), stage('a', 1), stage('won', 4, 'won')];

  it('splits into open stages (by position), Won and Lost', () => {
    const { open, won, lost } = splitStages(stages);
    expect(open.map((s) => s.id)).toEqual(['a', 'b']);
    expect(won?.id).toBe('won');
    expect(lost?.id).toBe('lost');
  });

  it('puts Won and Lost after the open stages, whatever the input order', () => {
    const { open, won, lost } = splitStages(stages);
    expect(boardOrder([...open].reverse(), won, lost).map((s) => s.id)).toEqual([
      'b',
      'a',
      'won',
      'lost',
    ]);
  });

  it('copes with a missing terminal stage instead of throwing', () => {
    expect(boardOrder([stage('a', 1)], undefined, undefined).map((s) => s.id)).toEqual(['a']);
  });

  it('renumbers 1..n and returns only what moved', () => {
    const ordered = [
      stage('a', 1),
      stage('new', 3),
      stage('won', 3, 'won'),
      stage('lost', 4, 'lost'),
    ];
    expect(positionChanges(ordered)).toEqual([{ id: 'new', position: 2 }]);
  });

  it('an already compact board writes nothing', () => {
    expect(positionChanges([stage('a', 1), stage('b', 2), stage('won', 3, 'won')])).toEqual([]);
  });

  it('closes the gap after a stage is removed', () => {
    expect(positionChanges([stage('a', 1), stage('c', 3), stage('won', 4, 'won')])).toEqual([
      { id: 'c', position: 2 },
      { id: 'won', position: 3 },
    ]);
  });
});
