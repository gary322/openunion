import { test, expect } from '@playwright/test';
import { gotoWorkerView, openDetails } from './helpers.js';

test('worker portal: exercise save token + me buttons', async ({ page }) => {
  await page.goto('/worker/index.html');

  await gotoWorkerView(page, 'auth');
  await openDetails(page, '#auth');

  await page.click('#btnRegister');
  await expect(page.locator('#authStatus')).toContainText('Registered workerId=');

  const token = await page.locator('#token').inputValue();
  expect(token).toMatch(/^pw_wk_/);

  // Save token should persist to localStorage.
  await page.click('#btnSaveToken');
  await expect(page.locator('#authStatus')).toContainText('Token saved');
  await page.reload();
  await gotoWorkerView(page, 'auth');
  await openDetails(page, '#auth');
  await expect(page.locator('#token')).toHaveValue(token);

  // /me should greet the worker.
  await page.click('#btnMe');
  await expect(page.locator('#authStatus')).toContainText('Hello worker');
});
