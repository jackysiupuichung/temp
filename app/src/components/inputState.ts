/** Tiny shared mutable input state (not reactive on purpose; read at pointerdown time). */
export const inputState = {
  spaceDown: false,
  /** id of the pointer currently drawing with a pen, or null */
  activePenPointer: null as number | null,
  isSafari: typeof navigator !== 'undefined' && /^((?!chrome|android).)*safari/i.test(navigator.userAgent),
};
