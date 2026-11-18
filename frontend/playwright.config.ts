import { defineConfig } from '@playwright/test';

const demoUrl = process.env.DEMO_URL;

export default defineConfig({
  webServer: demoUrl ? undefined : [
    {
      command: './mvnw -B -ntp spring-boot:run',
      cwd: '../backend',
      url: 'http://127.0.0.1:8092/api/health',
      timeout: 120000,
      reuseExistingServer: false,
      env: {
        PORT: '8092',
        SERVER_ADDRESS: '127.0.0.1',
        DATABASE_URL: 'jdbc:h2:mem:browser;DB_CLOSE_DELAY=-1',
        DATABASE_USERNAME: 'sa',
        DATABASE_PASSWORD: '',
        SEED_SIZE: '0',
        WORKSHOP_TOKEN: process.env.WORKSHOP_TOKEN ?? 'local-workshop',
      },
    },
    {
      command: 'npm run dev',
      url: 'http://127.0.0.1:5175',
      reuseExistingServer: false,
    },
  ],
  testDir: './tests',
  timeout: 60000,
  workers: 1,
  use: {
    baseURL: demoUrl ?? 'http://127.0.0.1:5175',
    viewport: { width: 1440, height: 1050 },
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    } : {},
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
