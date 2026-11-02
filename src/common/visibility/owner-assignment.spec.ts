import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { ownerForCreate, ownerForTransfer } from './owner-assignment';
import { OwnershipScopeService } from './ownership-scope.service';
import { VisibilityScope } from './visibility.types';

const scope: VisibilityScope = { kind: 'owners', ownerIds: ['me', 'r1'] };
const ownership = { resolve: vi.fn(), resolveAssignableOwner: vi.fn() };
const service = ownership as unknown as OwnershipScopeService;
const actor = { userId: 'me', organizationId: 'org', role: 'SALES_REP' } as AuthenticatedUser;

beforeEach(() => {
  vi.resetAllMocks();
  ownership.resolve.mockResolvedValue(scope);
});

describe('ownerForCreate', () => {
  it.each([undefined, 'me'])('%s means the caller, with no check', async (requested) => {
    await expect(ownerForCreate(service, actor, requested)).resolves.toBe('me');
    expect(ownership.resolveAssignableOwner).not.toHaveBeenCalled();
  });

  it('another owner goes through resolveAssignableOwner with the caller scope', async () => {
    ownership.resolveAssignableOwner.mockResolvedValue('r1');
    await expect(ownerForCreate(service, actor, 'r1')).resolves.toBe('r1');
    expect(ownership.resolveAssignableOwner).toHaveBeenCalledWith(scope, 'r1');
  });
});

describe('ownerForTransfer', () => {
  it('an unchanged owner is neither checked nor written', async () => {
    await expect(ownerForTransfer(service, scope, 'r1', 'r1')).resolves.toBeUndefined();
    expect(ownership.resolveAssignableOwner).not.toHaveBeenCalled();
  });

  it('a real transfer is checked once', async () => {
    ownership.resolveAssignableOwner.mockResolvedValue('r1');
    await expect(ownerForTransfer(service, scope, 'r1', 'me')).resolves.toBe('r1');
    expect(ownership.resolveAssignableOwner).toHaveBeenCalledWith(scope, 'r1');
  });
});
