/**
 * A container that wraps a component and provides resize and close behavior.
 * It can be styled in the css.
 */
export class ResizableContainer {
    constructor({ parent, component, onClose }) {
        this.parent = parent;
        this.component = component;
        this.onClose = onClose;
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
        this.container.style.position = "relative";
        this.container.style.display = "inline-block";
        this.container.style.borderRadius = "8px";
        this.container.style.overflow = "hidden"; // clips inner content nicely
        this.container.style.background = "#1111"; // dark
        this.container.style.border = "1px solid #00ff88";
        this.container.style.boxShadow = "0 4px 22px rgba(0,0,0,0.4)";

        // Close button
        this.closeButton = document.createElement("button");
        this.closeButton.style.display = "flex";
        this.closeButton.style.alignItems = "center";
        this.closeButton.style.justifyContent = "center";
        this.closeButton.style.fontSize = "11px";
        this.closeButton.style.lineHeight = "1";
        this.closeButton.style.padding = "0";
        this.closeButton.textContent = "x";

        this.closeButton.style.position = "absolute";
        this.closeButton.style.top = "0px";
        this.closeButton.style.right = "0px";

        this.closeButton.style.width = "20px";
        this.closeButton.style.height = "20px";
        this.closeButton.style.minWidth = "20px";
        this.closeButton.style.minHeight = "20px";

        this.closeButton.style.border = "none";
        this.closeButton.style.borderRadius = "0 8px 0 8px";
        this.closeButton.style.background = "rgba(0,0,0,0.6)";
        this.closeButton.style.color = "#00ff88";
        this.closeButton.style.cursor = "pointer";

        this.closeButton.addEventListener("click", () => {
            this.resizeObserver.disconnect();
            this.container.remove();
            this.onClose();
        });

        // reserve space for the close-button
        this.container.style.paddingRight = this.closeButton.style.width;

        // Assemble
        this.container.appendChild(this.closeButton);
        this.component.mount(this.container);
        this.parent.appendChild(this.container);
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(this.container);
        this.resize();
    }

    prepend(element) {
        this.prependedElements.push(element);
        this.container.prepend(element);
    }

    resize() {
        const styles = window.getComputedStyle(this.container);

        const horizontalPadding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
        const verticalPadding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
        const preAddedHeight = this.prependedElements.reduce((height, element) => height + element.offsetHeight, 0);

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

