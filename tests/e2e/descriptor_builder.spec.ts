import { test, expect } from '@playwright/test';

test('descriptor builder loads and schema is reachable', async ({ page }) => {
  await page.goto('/admin/descriptor-builder.html');
  await expect(page.locator('text=Task Descriptor Builder')).toBeVisible();

  // Ensure schema endpoint is reachable (browser fetch)
  const resp = await page.request.get('/contracts/task_descriptor.schema.json');
  expect(resp.ok()).toBeTruthy();
});

