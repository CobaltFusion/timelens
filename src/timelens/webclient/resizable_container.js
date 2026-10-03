import { performanceMonitor } from "./globals.js"

// at most one container is selected at a time
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

        this._createContainer();
    }

    _createContainer() {
        // Outer box
        this.container = document.createElement("div");
        this.container.classList.add("resizable-container");

        // capture phase, so the click selects the container even if a child handles the event
        this.container.addEventListener("pointerdown", () => this.select(), { capture: true });

        // Close button
        this.closeButton = document.createElement("button");
        this.closeButton.classList.add("resizable-container-close");
        this.closeButton.textContent = "x";
        this.closeButton.title = "Close this graph";

        this.closeButton.addEventListener("click", () => this.close());

        // Assemble
        this.container.appendChild(this.closeButton);
        this.component.mount(this.container);
        this.parent.appendChild(this.container);
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(this.container);
        this.resize();
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

