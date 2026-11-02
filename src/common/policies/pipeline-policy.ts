// Rules for pipelines and their stages, shared by the API and the seed / org:create CLI so the
// default pipeline has ONE definition. Pure: no framework imports.
export const PIPELINE_NAME_MAX_LENGTH = 100;
export const STAGE_NAME_MAX_LENGTH = 100;
// Open stages only: Won and Lost are added on top of this.
export const MAX_OPEN_STAGES = 20;
// An open stage cannot claim certainty; the terminal stages' probability is fixed by the server
// (a client never sends it).
export const OPEN_STAGE_MAX_PROBABILITY = 99;
export const WON_STAGE_PROBABILITY = 100;
export const LOST_STAGE_PROBABILITY = 0;
export const WON_STAGE_NAME = 'Won';
export const LOST_STAGE_NAME = 'Lost';

export interface OpenStageInput {
  name: string;
  probability: number;
}

export const DEFAULT_PIPELINE_TEMPLATE = {
  name: 'Sales Pipeline',
  openStages: [
    { name: 'Prospecting', probability: 10 },
    { name: 'Qualified', probability: 25 },
    { name: 'Proposal', probability: 50 },
    { name: 'Negotiation', probability: 75 },
  ],
} as const satisfies { name: string; openStages: readonly OpenStageInput[] };

// The stages of a new pipeline in board order, positions 1..n: the open stages as given, then Won,
// then Lost. The only place the terminal stages are built.
export function buildStageRows(openStages: readonly OpenStageInput[]) {
  return [
    ...openStages.map((stage) => ({ ...stage, isWon: false, isLost: false })),
    { name: WON_STAGE_NAME, probability: WON_STAGE_PROBABILITY, isWon: true, isLost: false },
    { name: LOST_STAGE_NAME, probability: LOST_STAGE_PROBABILITY, isWon: false, isLost: true },
  ].map((stage, index) => ({ ...stage, position: index + 1 }));
}
