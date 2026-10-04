/**
 * What the Chrome toolbar icon shows for the open message.
 *
 * Pure so the mapping can be asserted without Chrome. The content script decides the appearance from
 * tab status + settings; the service worker only paints what it is told onto `chrome.action` for that
 * tab, because content scripts cannot call the action API themselves.
 */
import type { Classification } from './types.js';
import type { TabStatus } from './messaging.js';

export interface ToolbarBadgeAppearance {
  /** Empty string clears the badge. At most a few characters fit on the icon. */
  text: string;
  background: string;
  textColor: string;
  /** Tooltip when hovering the toolbar icon for this tab. */
  title: string;
}

const DEFAULT_TITLE = 'ShoutPhish';

/**
 * Solid colours matched to the in-mail badge bands. The toolbar only supports a flat fill, so these
 * use the band's ink (or the high-risk fill) rather than the pastel chip backgrounds.
 */
const BAND_COLOURS: Readonly<
  Record<Classification, { background: string; textColor: string; label: string }>
> = {
  low: { background: '#137333', textColor: '#ffffff', label: 'Low Risk' },
  caution: { background: '#e37400', textColor: '#ffffff', label: 'Caution' },
  suspicious: { background: '#d93025', textColor: '#ffffff', label: 'Suspicious' },
  'high-risk': { background: '#b3261e', textColor: '#ffffff', label: 'High Risk' },
};

const CLEAR: ToolbarBadgeAppearance = {
  text: '',
  background: '#5f6368',
  textColor: '#ffffff',
  title: DEFAULT_TITLE,
};

/**
 * Until the reader agrees to their mail being read, nothing in Gmail is checked, and no in-mail badge
 * ever appears. Without a mark here that would look exactly like an inbox of clean mail, so the icon
 * says so on every tab until the welcome page's button is pressed.
 */
export const NOT_STARTED: ToolbarBadgeAppearance = {
  text: 'OFF',
  background: '#5f6368',
  textColor: '#ffffff',
  title: 'ShoutPhish is not checking your mail yet. Click to start.',
};

const UNREADABLE: ToolbarBadgeAppearance = {
  text: '?',
  background: '#5f6368',
  textColor: '#ffffff',
  title: 'ShoutPhish: Not checked',
};

/**
 * Toolbar badge for the current tab status.
 *
 * Honours `showBadgeWhenLow` the same way the in-mail badge does: a low score with that setting off
 * clears the icon, so the toolbar never looks like an all-clear the header deliberately hid.
 */
export function toolbarBadgeAppearance(
  status: TabStatus,
  options: { showBadgeWhenLow: boolean },
): ToolbarBadgeAppearance {
  switch (status.kind) {
    case 'no-message':
    case 'pending':
      return CLEAR;
    case 'unreadable':
      return UNREADABLE;
    case 'scored': {
      if (status.classification === 'low' && !options.showBadgeWhenLow) return CLEAR;
      const band = BAND_COLOURS[status.classification];
      return {
        text: String(status.score),
        background: band.background,
        textColor: band.textColor,
        title: `ShoutPhish: ${band.label} ${String(status.score)}/100`,
      };
    }
  }
}
