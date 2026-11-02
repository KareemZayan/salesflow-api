import { HttpException } from '@nestjs/common';
import { assertHasChanges } from './assert-has-changes.util';

describe('assertHasChanges', () => {
  it.each([{}, { name: undefined }])('rejects %j with 400 EMPTY_UPDATE', (dto) => {
    try {
      assertHasChanges(dto);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(400);
      expect(JSON.stringify((error as HttpException).getResponse())).toContain('EMPTY_UPDATE');
    }
  });

  it.each([{ name: 'x' }, { domain: null }, { name: '' }, { active: false }])(
    'accepts %j (null, empty and false are real values)',
    (dto) => {
      expect(() => assertHasChanges(dto)).not.toThrow();
    },
  );
});
