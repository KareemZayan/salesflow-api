import { Test } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import { TenantContextService } from './tenant-context.service';

describe('TenantContextService', () => {
  let cls: ClsService;
  let tenant: TenantContextService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true })],
      providers: [TenantContextService],
    }).compile();
    cls = module.get(ClsService);
    tenant = module.get(TenantContextService);
  });

  it('has no tenant outside a context', () => {
    expect(tenant.organizationId).toBeUndefined();
    expect(tenant.includeDeleted).toBe(false);
  });

  it('stores the authenticated user inside a context', async () => {
    await cls.run(async () => {
      tenant.setUser({ userId: 'u1', organizationId: 'org-a' });
      expect(tenant).toMatchObject({ userId: 'u1', organizationId: 'org-a' });
    });
  });

  it('run() sets the tenant for jobs and does not leak after', async () => {
    await tenant.run('org-job', async () => {
      expect(tenant.organizationId).toBe('org-job');
    });
    expect(tenant.organizationId).toBeUndefined();
  });

  it('withDeleted() keeps the tenant and only flips the flag inside its callback', async () => {
    await tenant.run('org-a', async () => {
      await tenant.withDeleted(async () => {
        expect(tenant.includeDeleted).toBe(true);
        expect(tenant.organizationId).toBe('org-a');
      });
      expect(tenant.includeDeleted).toBe(false);
    });
  });
});
