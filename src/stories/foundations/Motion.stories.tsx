import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { MotionLab } from '@/app/system/demos';

const meta = {
  title: 'Foundations/Motion',
  parameters: {
    docs: {
      description: {
        component:
          'The transitions.dev scale, matched by usage: quick 150ms (close, text swap), fast 250ms (menus, tabs, icon swap), medium 350ms (panel close, toggle), slow 400ms (panel open, reveal), very slow 500ms (digits, text reveal, success). Open/close eases with cubic-bezier(0.22, 1, 0.36, 1). Every animation respects prefers-reduced-motion. Tap each card.',
      },
    },
  },
} satisfies Meta;

export default meta;

export const Everything: StoryObj = { render: () => <MotionLab /> };
