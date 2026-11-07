import { HttpException, Logger } from '@nestjs/common';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { AuditService } from '../audit-logs/audit.service';
import { OrganizationRecord, OrganizationsRepository } from './organizations.repository';
import { OrganizationsService } from './organizations.service';

const TX = { tx: true };
const repository = { findById: vi.fn(), update: vi.fn(), withOrgLock: vi.fn() };
const audit = { record: vi.fn() };
const service = new OrganizationsService(
  repository as unknown as OrganizationsRepository,
  audit as unknown as AuditService,
);

const actor: AuthenticatedUser = {
  userId: 'user-1',
  organizationId: 'org-1',
  role: 'ADMIN',
  permissions: ['organizations:update'],
  mustChangePassword: false,
};

const record = (overrides: Partial<OrganizationRecord> = {}): OrganizationRecord => ({
  id: 'org-1',
  name: 'Acme',
  slug: 'acme',
  defaultCurrency: 'USD',
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const failure = async (promise: Promise<unknown>): Promise<[number, string]> => {
  try {
    await promise;
  } catch (error) {
    const http = error as HttpException;
    return [http.getStatus(), (http.getResponse() as { code: string }).code];
  }
  throw new Error('expected a failure');
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  repository.withOrgLock.mockImplementation((_id: string, work: (tx: unknown) => unknown) =>
    work(TX),
  );
});

describe('OrganizationsService', () => {
  it("reads only the caller's own organization", async () => {
    repository.findById.mockResolvedValue(record());
    await service.getCurrent(actor);
    expect(repository.findById).toHaveBeenCalledWith('org-1');
  });

  it('answers 404 when the organization is gone', async () => {
    repository.findById.mockResolvedValue(null);
    expect(await failure(service.getCurrent(actor))).toEqual([404, 'RESOURCE_NOT_FOUND']);
  });

  it('updates the caller organization with only the provided fields', async () => {
    repository.findById.mockResolvedValue(record());
    repository.update.mockResolvedValue(record({ name: 'New' }));
    await service.updateCurrent(actor, { name: 'New' });
    expect(repository.update).toHaveBeenCalledWith(
      'org-1',
      { name: 'New', defaultCurrency: undefined },
      TX,
    );
  });

  it('audits the change in the same transaction, with the old and new values', async () => {
    repository.findById.mockResolvedValue(record());
    repository.update.mockResolvedValue(record({ name: 'New' }));
    await service.updateCurrent(actor, { name: 'New' });
    expect(audit.record).toHaveBeenCalledWith(TX, {
      event: 'organization.updated',
      entityId: 'org-1',
      before: { name: 'Acme', defaultCurrency: 'USD' },
      after: { name: 'New', defaultCurrency: 'USD' },
    });
  });

  it('records nothing when the organization is gone', async () => {
    repository.findById.mockResolvedValue(null);
    repository.update.mockResolvedValue(null);
    await failure(service.updateCurrent(actor, { name: 'X' }));
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects an empty update with 400', async () => {
    expect(await failure(service.updateCurrent(actor, {}))).toEqual([400, 'BAD_REQUEST']);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('answers 404 when the update matched nothing', async () => {
    repository.update.mockResolvedValue(null);
    expect(await failure(service.updateCurrent(actor, { name: 'X' }))).toEqual([
      404,
      'RESOURCE_NOT_FOUND',
    ]);
  });
});
