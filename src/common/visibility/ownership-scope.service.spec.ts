import { HttpException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { OwnershipScopeService } from './ownership-scope.service';
import { VisibilityRepository } from './visibility.repository';

const repository = { findDirectReportIds: vi.fn() };
const store = new Map<string, unknown>();
const cls = {
  isActive: vi.fn(() => true),
  get: (key: string) => store.get(key),
  set: (key: string, value: unknown) => store.set(key, value),
};
const service = new OwnershipScopeService(
  repository as unknown as VisibilityRepository,
  cls as unknown as ClsService,
);

const actor = (role: string, userId = 'me'): AuthenticatedUser => ({
  userId,
  organizationId: 'org',
  role,
  permissions: [],
  mustChangePassword: false,
});

beforeEach(() => {
  vi.resetAllMocks();
  store.clear();
  cls.isActive.mockReturnValue(true);
});

describe('OwnershipScopeService.resolve', () => {
  it('ADMIN sees everything and costs no query', async () => {
    expect(await service.resolve(actor('ADMIN'))).toEqual({ kind: 'all' });
    expect(repository.findDirectReportIds).not.toHaveBeenCalled();
  });

  it('SALES_MANAGER sees self plus direct reports', async () => {
    repository.findDirectReportIds.mockResolvedValue(['r1', 'r2']);
    expect(await service.resolve(actor('SALES_MANAGER'))).toEqual({
      kind: 'owners',
      ownerIds: ['me', 'r1', 'r2'],
    });
  });

  it.each(['SALES_REP', 'SUPPORT', 'anything-custom'])('%s sees own records only', async (role) => {
    expect(await service.resolve(actor(role))).toEqual({ kind: 'owners', ownerIds: ['me'] });
    expect(repository.findDirectReportIds).not.toHaveBeenCalled();
  });

  it('loads the team once per request, even for parallel calls', async () => {
    repository.findDirectReportIds.mockResolvedValue(['r1']);
    const [a, b] = await Promise.all([
      service.resolve(actor('SALES_MANAGER')),
      service.resolve(actor('SALES_MANAGER')),
    ]);
    await service.resolve(actor('SALES_MANAGER'));
    expect(a).toBe(b);
    expect(repository.findDirectReportIds).toHaveBeenCalledTimes(1);
  });

  it('does not cache across requests (a new CLS store starts empty)', async () => {
    repository.findDirectReportIds.mockResolvedValue(['r1']);
    await service.resolve(actor('SALES_MANAGER'));
    store.clear(); // next request
    repository.findDirectReportIds.mockResolvedValue(['r1', 'r2']);
    expect(await service.resolve(actor('SALES_MANAGER'))).toEqual({
      kind: 'owners',
      ownerIds: ['me', 'r1', 'r2'],
    });
  });

  it('does not cache outside a request context', async () => {
    cls.isActive.mockReturnValue(false);
    repository.findDirectReportIds.mockResolvedValue([]);
    await service.resolve(actor('SALES_MANAGER'));
    await service.resolve(actor('SALES_MANAGER'));
    expect(repository.findDirectReportIds).toHaveBeenCalledTimes(2);
  });

  it('forgets a failed load so the next call can retry', async () => {
    repository.findDirectReportIds.mockRejectedValueOnce(new Error('db down'));
    await expect(service.resolve(actor('SALES_MANAGER'))).rejects.toThrow('db down');
    repository.findDirectReportIds.mockResolvedValue([]);
    expect(await service.resolve(actor('SALES_MANAGER'))).toEqual({
      kind: 'owners',
      ownerIds: ['me'],
    });
  });

  it('throws 401 when there is no actor', async () => {
    const error = await service.resolve(undefined).catch((e: HttpException) => e);
    expect((error as HttpException).getStatus()).toBe(401);
  });
});
