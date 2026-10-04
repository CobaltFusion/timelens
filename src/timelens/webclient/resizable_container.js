import { performanceMonitor } from "./singletons.js";

// at most one container is selected at a time
/** @type {ResizableContainer | null} */
let selectedContainer = null;

/**
 * A container that wraps a component and provides resize and close behavior.
 * It is styled in the css: 'resizable-container', 'resizable-container-close',
 * and 'selected' for the selected container. Clicking inside the container selects it.
 */
export class ResizableContainer {
    constructor({ parent, component, onClose, onSelect = null }) {
        this.parent = parent;
        this.component = component;
        this.onClose = onClose;
        this.onSelect = onSelect;
        this.prependedElements = []

        if (!(this.parent instanceof HTMLElement)) {
            throw new TypeError("parent must be an HTMLElement");
        }
        if (!isComponent(this.component)) {
            throw new TypeError("component must be an object of 'Component' ducktype");
        }

        // created here and put together by '_createContainer()', so they are never undefined
        this.container = document.createElement("div");
        this.closeButton = document.createElement("button");
        this.grip = document.createElement("div");
        this.resizeObserver = new ResizeObserver(() => this.resize());

        this._createContainer();
    }

    _createContainer() {
        // Outer box
        this.container.classList.add("resizable-container");

        // capture phase, so the click selects the container even if a child handles the event
        this.container.addEventListener("pointerdown", () => this.select(), { capture: true });

        // Close button
        this.closeButton.classList.add("resizable-container-close");
        this.closeButton.textContent = "x";
        this.closeButton.title = "Close this graph";

        this.closeButton.addEventListener("click", () => this.close());

        // The grip in the bottom right corner, drag it to resize. The handle of the browser ('resize: both' in the css) is
        // not there on iOS, and not under a finger either: this one works with a mouse, a pen and a touch screen.
        this.grip.classList.add("resizable-container-grip");
        this.grip.title = "Drag to resize this graph";
        this.grip.addEventListener("pointerdown", (e) => this._startResize(e));

        // Assemble
        this.container.appendChild(this.closeButton);
        this.container.appendChild(this.grip);
        this.component.mount(this.container);
        this.parent.appendChild(this.container);
        this.resizeObserver.observe(this.container);
        this.resize();
    }

    // Resizes the container while the pointer that started on the grip moves. The pointer is captured by the grip, so the
    // moves keep coming when it is outside the grip, and outside the window.
    _startResize(e) {
        if (e.pointerType === "mouse" && e.button !== 0) {
            return;     // only the main button
        }
        e.preventDefault();
        e.stopPropagation();

        const grip = this.grip;
        grip.setPointerCapture(e.pointerId);

        const start = { x: e.clientX, y: e.clientY, width: this.container.offsetWidth, height: this.container.offsetHeight };
        const maxWidth = this.parent.clientWidth;       // not wider than the page, the css has the least size

        const move = (/** @type {PointerEvent} */ m) => {
            this.container.style.width = `${Math.min(maxWidth, Math.max(0, start.width + m.clientX - start.x))}px`;
            this.container.style.height = `${Math.max(0, start.height + m.clientY - start.y)}px`;
        };
        const end = () => {
            grip.removeEventListener("pointermove", move);
            grip.removeEventListener("pointerup", end);
            grip.removeEventListener("pointercancel", end);
        };
        grip.addEventListener("pointermove", move);
        grip.addEventListener("pointerup", end);
        grip.addEventListener("pointercancel", end);
    }

    close() {
        if (selectedContainer === this) {
            selectedContainer = null;
        }
        this.resizeObserver.disconnect();
        this.container.remove();
        this.onClose();
    }

    // the size set by resizing the container, empty strings when it was not resized (the css decides)
    getSize() {
        return { width: this.container.style.width, height: this.container.style.height };
    }

    /** @param {{ width?: string, height?: string }} size */
    setSize({ width = "", height = "" }) {
        this.container.style.width = width;
        this.container.style.height = height;
    }

    select() {
        if (selectedContainer === this) {
            return;
        }
        selectedContainer?.container.classList.remove("selected");
        selectedContainer = this;
        this.container.classList.add("selected");
        this.onSelect?.(this);
    }

    isSelected() {
        return selectedContainer === this;
    }

    /** @returns {ResizableContainer | null} */
    static getSelected() {
        return selectedContainer;
    }

    prepend(element) {
        this.prependedElements.push(element);
        this.container.prepend(element);
    }

    resize() {
        performanceMonitor.countResize();
        const styles = window.getComputedStyle(this.container);

        const horizontalPadding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
        const verticalPadding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);

        const preAddedHeight = this.prependedElements.reduce((height, element) => {
            const styles = window.getComputedStyle(element);
            return height + element.offsetHeight + parseFloat(styles.marginTop) + parseFloat(styles.marginBottom);
        }, 0);

        const width = Math.max(0, this.container.clientWidth - horizontalPadding);
        const height = Math.max(0, this.container.clientHeight - verticalPadding - preAddedHeight);
        this.component.resize(width, height);
    }
}

// duck-typing for Component classes
function isComponent(obj) {
    return obj &&
        typeof obj.element === "function" &&
        typeof obj.mount === "function" &&
        typeof obj.resize === "function";
}

