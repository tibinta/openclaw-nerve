/* @vitest-environment node */
import { describe, expect, it } from 'vitest';
import app from './upload-config.js';

describe('GET /api/upload-config', () => {
  it('returns stable chat upload defaults instead of 404', async () => {
    const res = await app.request('/api/upload-config');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      twoModeEnabled: true,
      inlineEnabled: true,
      fileReferenceEnabled: true,
      modeChooserEnabled: true,
      inlineImageAutoDowngradeToFileReference: true,
      exposeInlineBase64ToAgent: false,
    });
  });
});
