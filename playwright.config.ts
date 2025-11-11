import { defineConfig } from '@playwright/test';

export default defineConfig({
  // 🔹 Här ligger dina testfiler
  testDir: './tests',

  // 🔹 Rapporter (HTML + JSON för PR-kommentaren)
  reporter: [
    ['html', { open: 'never' }],
    ['json', { outputFile: 'report.json' }],
    ['list']
  ],

  // 🔹 Grundinställningar
  use: {
    baseURL: 'https://mangepang.github.io/test_ci/',  // din viewer-URL
    headless: true,                                   // kör i headless-läge i CI
    trace: 'on-first-retry',                          // användbar för felsökning
  },

  // 🔹 Timeoutar och retrys kan justeras om du vill
  timeout: 30 * 1000,
  retries: 0
});
