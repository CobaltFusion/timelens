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
