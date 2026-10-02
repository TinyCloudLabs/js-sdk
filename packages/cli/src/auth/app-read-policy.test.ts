import { describe, expect, test } from 'bun:test';
import fixture from './fixtures/app-read-policy-v1.json';
import { appReadSelection, deriveAppReadPermissions, sha256 } from './app-read-policy.js';

describe('shared app-read protocol policy fixtures', () => {
  for (const item of fixture.cases) test(item.name, () => {
    const application = structuredClone(item.application) as any;
    if ('pathRepeat' in item) application.manifests[0].permissions[0].path = 'x'.repeat(item.pathRepeat!);
    if ('errorCode' in item) {
      expect(() => deriveAppReadPermissions(application, fixture.binding)).toThrow(expect.objectContaining({ code: item.errorCode }));
    } else {
      expect(deriveAppReadPermissions(application, fixture.binding)).toEqual(item.expectedPermissions);
      const selection = appReadSelection(application, fixture.binding);
      const { selectionDigest, ...binding } = selection;
      expect(selection).toMatchObject({ protocolVersion: fixture.protocolVersion, permissions: item.expectedPermissions });
      expect(selectionDigest).toBe(sha256(binding));
    }
  });
});
