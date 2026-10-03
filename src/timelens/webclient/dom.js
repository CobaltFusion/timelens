/**
 * The element with this id. The elements looked up this way are part of the page,
 * so a missing one is a programming error: this throws, with a message that names it,
 * instead of letting a later line fail on 'null'.
 * @param {string} id
 * @returns {HTMLElement}
 */
export function requireElement(id) {
    const element = document.getElementById(id);
    if (!element) {
        throw new Error(`Missing element #${id} in the page`);
    }
    return element;
}

/**
 * The 2D drawing context of a canvas. Browsers only return null when the canvas already has a
 * different kind of context, so that is a programming error: this throws instead of returning null.
 * @param {HTMLCanvasElement} canvas
 * @returns {CanvasRenderingContext2D}
 */
export function require2dContext(canvas) {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        throw new Error("The canvas has no 2D context");
    }
    return ctx;
}
