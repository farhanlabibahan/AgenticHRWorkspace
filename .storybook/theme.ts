import { create } from 'storybook/theming';

/**
 * The Storybook chrome, dressed like the app (docs/09): warm canvas, white
 * surfaces, ink text, recessed inputs, and the logo (public/brand).
 */
export default create({
  base: 'light',
  brandTitle:
    '<span style="display:inline-flex;align-items:center;gap:10px"><img src="./brand/source-lockup-light.svg" alt="Source" height="32" style="height:32px;image-rendering:pixelated" /><span style="font-family:Geist,system-ui;font-size:13px;font-weight:500;color:#6b6a67">Design system</span></span>',
  brandUrl: '/',
  brandTarget: '_self',

  fontBase: 'Geist, system-ui, -apple-system, sans-serif',
  fontCode: "'Fragment Mono', ui-monospace, Menlo, monospace",

  colorPrimary: '#0a0a0a',
  colorSecondary: '#0a0a0a',

  appBg: '#f5f4f2',
  appContentBg: '#fdfcfc',
  appPreviewBg: '#f5f4f2',
  appBorderColor: 'rgba(10, 10, 10, 0.07)',
  appBorderRadius: 12,

  textColor: '#0a0a0a',
  textInverseColor: '#f5f4f2',
  textMutedColor: '#6b6a67',

  barTextColor: '#6b6a67',
  barHoverColor: '#0a0a0a',
  barSelectedColor: '#0a0a0a',
  barBg: '#ffffff',

  buttonBg: '#ffffff',
  buttonBorder: 'transparent',
  booleanBg: '#edece9',
  booleanSelectedBg: '#ffffff',

  inputBg: '#edece9',
  inputBorder: 'transparent',
  inputTextColor: '#0a0a0a',
  inputBorderRadius: 8,
});
