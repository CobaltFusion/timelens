// Copying text to the clipboard.

/**
 * @typedef {Object} Environment    what is used, to test with
 * @property {Pick<Navigator, "clipboard"> | {clipboard?: undefined}} [nav]
 * @property {Document} [doc]
 * @property {boolean} [secure]     whether the page is a secure context
 */

/**
 * Copies 'text' to the clipboard, resolves with whether that worked.
 *
 * The clipboard of the browser (navigator.clipboard) only exists on a page that is a secure context: https, or
 * localhost. TimeLens is mostly opened as http://address:port, there it does not exist, and a text box that is selected
 * and copied with the 'copy' command is used. Both need a user gesture, call this from the handler of a click or a press.
 * The 'copy' command has to be called in the same turn as the gesture, so it is not tried after an await.
 *
 * @param {string} text
 * @param {Environment} [env]
 * @returns {Promise<boolean>}
 */
export function copyText(text, { nav = navigator, doc = document, secure = window.isSecureContext } = {}) {
    if (secure && nav.clipboard?.writeText) {
        return nav.clipboard.writeText(text).then(
            () => true,
            () => copyWithTextBox(doc, text));      // not allowed (a frame, no focus): the other way may be
    }
    return Promise.resolve(copyWithTextBox(doc, text));
}

/** A hidden text box with the text, selected and copied. Works on iOS too: it needs a selection range. */
function copyWithTextBox(doc, text) {
    const active = doc.activeElement;
    const box = doc.createElement("textarea");
    box.value = text;
    box.setAttribute("readonly", "");       // the keyboard of a tablet does not come up
    box.setAttribute("aria-hidden", "true");
    box.style.cssText = "position: fixed; top: 0; left: 0; width: 1px; height: 1px; padding: 0; border: 0; opacity: 0; font-size: 16px;";
    doc.body.appendChild(box);

    let copied = false;
    try {
        box.select();
        box.setSelectionRange(0, text.length);
        copied = doc.execCommand("copy");
    } catch {
        copied = false;
    } finally {
        box.remove();
        if (active instanceof HTMLElement) {
            active.focus({ preventScroll: true });
        }
    }
    return copied;
}
