/**
 * Shared geometry for the live board layers. The surface, the event marks and the
 * tracking overlay are separate SVGs stacked on top of each other; they must share
 * this viewBox (metres, pitch at 0..105 x 0..68 with a grass apron) and the CSS tilt
 * in board.css so every layer lines up.
 */
export const PITCH_APRON_M = 6;
export const PITCH_VIEWBOX = `${-PITCH_APRON_M} ${-PITCH_APRON_M} ${105 + 2 * PITCH_APRON_M} ${68 + 2 * PITCH_APRON_M}`;

export const svgTranslate = (x: number, y: number) => `translate(${x.toFixed(2)} ${y.toFixed(2)})`;
