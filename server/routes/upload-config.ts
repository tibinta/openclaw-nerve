/**
 * GET /api/upload-config — chat attachment feature flags.
 *
 * The frontend asks for this at startup. Keep the response small and stable so
 * missing config never disables voice/chat flows with a noisy 404.
 */

import { Hono } from 'hono';
import { rateLimitGeneral } from '../middleware/rate-limit.js';

const app = new Hono();

const DEFAULT_UPLOAD_CONFIG = {
  twoModeEnabled: true,
  inlineEnabled: true,
  fileReferenceEnabled: true,
  modeChooserEnabled: true,
  inlineAttachmentMaxMb: 4,
  inlineImageContextMaxBytes: 32_768,
  inlineImageAutoDowngradeToFileReference: true,
  inlineImageShrinkMinDimension: 512,
  inlineImageMaxDimension: 2048,
  inlineImageWebpQuality: 82,
  exposeInlineBase64ToAgent: false,
};

app.get('/api/upload-config', rateLimitGeneral, (c) => {
  return c.json(DEFAULT_UPLOAD_CONFIG);
});

export default app;
