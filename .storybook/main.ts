import path from 'node:path';
import type { StorybookConfig } from '@storybook/nextjs-vite';

/**
 * Source's design system in Storybook. Stories live in src/stories, ordered
 * the way docs/09 reads (see preview.tsx storySort), not alphabetically.
 */
const config: StorybookConfig = {
  stories: ['../src/stories/**/*.mdx', '../src/stories/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y'],
  framework: { name: '@storybook/nextjs-vite', options: {} },
  // /fonts for the manager's Geist, /api/logo stays a 404 in isolation
  staticDirs: ['../public'],
  docs: { defaultName: 'Docs' },
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
  // A design-system book, not a Storybook tutorial: no onboarding checklist,
  // no guide page, no interactions or actions panels (nothing uses them).
  features: { sidebarOnboardingChecklist: false, menuOnboardingChecklist: false, interactions: false, actions: false },
  // MDX goes through Vite without the tsconfig paths plugin, so alias @/ here
  viteFinal: (config) => {
    config.resolve ??= {};
    config.resolve.alias = { ...(config.resolve.alias ?? {}), '@': path.resolve(process.cwd(), 'src') };
    return config;
  },
};

export default config;
