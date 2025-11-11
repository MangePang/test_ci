import { test as base } from '@playwright/test';

export function withBpmn(bpmnId: string) {
  return (title: string) => `${title} [bpmn:${bpmnId}]`;
}

export async function annotateBpmn(testInfo: any, bpmnId: string, uc?: string) {
  testInfo.annotations.push({ type: 'bpmn', description: bpmnId });
  if (uc) testInfo.annotations.push({ type: 'uc', description: uc });
}
