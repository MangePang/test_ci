import { test, expect } from '@playwright/test';
import { withBpmn, annotateBpmn } from './helpers/bpmn';

const BPMN_ID = 'Activity_11wac6l';
const bpmnTitle = withBpmn(BPMN_ID);

test.describe('UC – Kundens inkomst (mock)', () => {

  test(bpmnTitle('Valid income (mock)'), async ({}, info) => {
    // Annotera testet så kopplingen till BPMN syns i rapporter
    await annotateBpmn(info, BPMN_ID, 'UC1');

    // Simulerad kontroll – exempel på logik vi senare kan ersätta
    const mockIncome = 65000;
    const isValid = mockIncome > 0 && mockIncome < 200000;

    expect(isValid).toBe(true);
  });

  test(bpmnTitle('Missing income -> error (mock)'), async ({}, info) => {
    await annotateBpmn(info, BPMN_ID, 'UC1');

    const mockIncome = undefined;
    const isValid = !!mockIncome;

    // Förväntas vara falskt – dvs. trigger "error"
    expect(isValid).toBe(false);
  });

});
