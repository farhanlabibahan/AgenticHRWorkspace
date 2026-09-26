import type { Preview } from '@storybook/nextjs-vite';
import { fragmentMono, geist } from '../src/app/fonts';
import theme from './theme';
import '../src/app/globals.css';

/**
 * Every story renders in the real type and tokens. The toolbar's "Surface"
 * switch puts a component on each ground it lives on — the app canvas, a
 * white card, or the marketing sheet — because in this system depth is
 * value, and a component is only right if it reads on all three.
 */

const GROUNDS = {
  canvas: 'var(--color-canvas)',
  surface: 'var(--color-surface)',
  sheet: 'var(--color-sheet)',
} as const;

const preview: Preview = {
  globalTypes: {
    ground: {
      description: 'The surface the story sits on',
      toolbar: {
        title: 'Surface',
        icon: 'contrast',
        items: [
          { value: 'canvas', title: 'Canvas — the app page' },
          { value: 'surface', title: 'Surface — inside a card' },
          { value: 'sheet', title: 'Sheet — the marketing page' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { ground: 'canvas' },

  decorators: [
    (Story, context) => {
      const ground = GROUNDS[(context.globals.ground as keyof typeof GROUNDS) ?? 'canvas'];
      const fullscreen = context.parameters.layout === 'fullscreen';
      return (
        <div
          className={`${geist.variable} ${fragmentMono.variable} font-sans text-ink`}
          style={{
            background: ground,
            minHeight: fullscreen ? '100vh' : undefined,
            padding: fullscreen ? 0 : 32,
            borderRadius: fullscreen ? 0 : 12,
          }}
        >
          <Story />
        </div>
      );
    },
  ],

  parameters: {
    layout: 'padded',
    // our Surface switch replaces the generic backgrounds addon
    backgrounds: { disable: true },
    controls: {
      expanded: true,
      sort: 'requiredFirst',
      matchers: { color: /(background|color)$/i },
    },
    viewport: {
      options: {
        phone: { name: 'Phone · 390', styles: { width: '390px', height: '844px' } },
        tablet: { name: 'Tablet · 820', styles: { width: '820px', height: '1180px' } },
        laptop: { name: 'Laptop · 1280', styles: { width: '1280px', height: '800px' } },
        desktop: { name: 'Desktop · 1440', styles: { width: '1440px', height: '900px' } },
      },
    },
    a11y: { test: 'todo' },
    docs: { theme, toc: { headingSelector: 'h2, h3' } },
    options: {
      storySort: {
        order: [
          'Introduction',
          'Foundations',
          ['Brand', 'Color', 'Typography', 'Space & grid', 'Shape & elevation', 'Motion'],
          'Components',
          [
            'Button',
            'Fields',
            'Chip',
            'Segmented',
            'Badge',
            'Card',
            'Checkbox',
            'Switch',
            'Dropdown',
            'Orb & avatar',
            'Assistant',
            'Charts',
          ],
          'Patterns',
          'Marketing',
          'Playground',
          ['Tokens', 'Dither', 'Face globe', 'Components'],
        ],
      },
    },
  },
};

export default preview;
