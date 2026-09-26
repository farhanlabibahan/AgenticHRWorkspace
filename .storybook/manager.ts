import { addons } from 'storybook/manager-api';
import theme from './theme';

addons.setConfig({
  theme,
  panelPosition: 'right',
  enableShortcuts: true,
  showToolbar: true,
  sidebar: { showRoots: true },
});
