export interface AutoplayState {
  reduced: boolean | null;
  paused: boolean;
  hovered: boolean;
  focused: boolean;
  visible: boolean;
  tabVisible: boolean;
  slides: number;
}

export function canAutoplay(state: AutoplayState): boolean {
  return state.reduced === false && !state.paused && !state.hovered &&
    !state.focused && state.visible && state.tabVisible && state.slides > 1;
}

export const HERO_INTERVAL = 6000;
