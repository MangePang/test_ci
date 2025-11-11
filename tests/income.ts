import { test, expect } from '@playwright/test';
import { withBpmn, annotateBpmn } from './helpers/bpmn';

// Koppla detta test till BPMN-elementet "Activity_11wac6l"
const BPMN_ID = 'Activity_11wac6l';
const bpmnTitle = withBpmn(BPMN_ID);

test.describe('UC – Kundens inkomst', () => {

  test(bpmnTitle('Valid income'), async ({ page }, info) => {
    await annotateBpmn(info, BPMN_ID, 'UC1');
    await page.goto('/loan/apply');
    await page.getByLabel('Monthly income').fill('65000');
    await page.getByRole('button', { name: 'Validate income' }).click();
    await expect(page.getByText('Income valid')).toBeVisible();
  });

  test(bpmnTitle('Missing income -> error'), async ({ page }, info) => {
    await annotateBpmn(info, BPMN_ID, 'UC1');
    await page.goto('/loan/apply');
    await page.getByRole('button', { name: 'Validate income' }).click();
    await expect(page.getByText('Income is required')).toBeVisible();
  });

});
