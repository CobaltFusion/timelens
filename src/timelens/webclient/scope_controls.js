//import { EventType } from "./collector.js";

class Widget {
    constructor({ parent, component, onClose }) {
        this.parent = parent;
        this.component = component;
        this.onClose = onClose;

        if (!(this.parent instanceof HTMLElement)) {
            throw new TypeError("parent must be an HTMLElement");
        }
        if (!(isComponent(this.component))) {
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
        this.container.style.background = "#1111"; // dark, matches scope vibe
        this.container.style.border = "1px solid #00ff88";
        this.container.style.boxShadow = "0 4px 22px rgba(0,0,0,0.4)";

        // Close button
        this.closeButton = document.createElement("button");
        this.closeButton.style.display = "flex";
        this.closeButton.style.alignItems = "center";
        this.closeButton.style.justifyContent = "center";
        this.closeButton.style.fontSize = "8px";
        this.closeButton.style.lineHeight = "1";
        this.closeButton.style.padding = "0";
        this.closeButton.textContent = "x";

        this.closeButton.style.position = "absolute";
        this.closeButton.style.top = "0px";
        this.closeButton.style.right = "0px";

        this.closeButton.style.width = "14px";
        this.closeButton.style.height = "14px";

        this.closeButton.style.border = "none";
        this.closeButton.style.borderRadius = "50%";
        this.closeButton.style.background = "rgba(0,0,0,0.6)";
        this.closeButton.style.color = "#00ff88";
        this.closeButton.style.cursor = "pointer";

        this.closeButton.addEventListener("click", () => {
            this.container.remove();
            this.onClose();
        });

        // Assemble
        this.container.appendChild(this.closeButton);
        this.component.mount(this.container);
        this.parent.appendChild(this.container);
        this.resize();
    }

    resize() {
        const rect = this.parent.getBoundingClientRect();
        this.component.resize(rect.width * 0.8, 200);
    }
}

// duck-typing for Component classes
function isComponent(obj) {
    return obj &&
        typeof obj.element === "function" &&
        typeof obj.mount === "function" &&
        typeof obj.resize === "function";
}

function getColor(c) {
    const hue = (c * 137.508) % 360;
    return `hsl(${hue}, 100%, 50%)`;
}

class Line {
    constructor(y) {
        this.y = y;
        this.openMap = new Map(); // limitation: no support for nested events with the same name
        this.closedEvents = [];
        this.lastEndTime = 0;
    }
}

class BarStack {
    constructor(ctx, mouseX, mouseY) {
        this.ctx = ctx;
        this.mouseX = mouseX;
        this.mouseY = mouseY;
        this.color = 1;
        this.y = 20;
        this.height = 12;
        this.lines = new Map();
        this.beginTime = Infinity;
    }

    getLine(id) {
        let entry = this.lines.get(id);
        if (!entry) {
            entry = this.makeLine();
            console.log("new line: " + entry.y);
            this.lines.set(id, entry);
        }
        return entry;
    }

    makeLine() {
        const line = new Line(this.y);
        this.y += 20;
        return line;
    }

    drawEvent(line, event) {
        const duration = event.end_time - event.begin_time;
        this.drawBar(line, event, event.name);
    }

    drawEvents() {
        for (const [, line] of this.lines) { // ignore id
            const unclosedEvents = Array.from(line.openMap.values());
            for (const event of unclosedEvents) {
                event.end_time = line.lastEndTime;      // notice: modifies the event without copying
                this.drawEvent(line, event);
            }

            for (const event of line.closedEvents) {
                this.drawEvent(line, event);
            }
        }
    }

    drawTextOnBar(hover, duration, x, y) {
        // width label
        this.ctx.fillStyle = "black";
        this.ctx.font = "10px monospace";
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "middle";
        this.ctx.fillText(`${hover} (${duration.toFixed(3)} ms)`, x, y);
    }

    drawTooltip(hover, duration) {
        const text = `${hover} (${duration.toFixed(3)} ms)`;

        this.ctx.font = "10px monospace";

        // Measure text size
        const metrics = this.ctx.measureText(text);
        const padding = 6;

        const tooltipWidth = metrics.width + padding * 2;
        const tooltipHeight = 16;

        // Position near mouse
        const tx = this.mouseX + 12;
        const ty = this.mouseY - 24;

        // Background
        this.ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
        this.ctx.fillRect(tx, ty, tooltipWidth, tooltipHeight);

        // Border
        this.ctx.strokeStyle = "#00ff88";
        this.ctx.strokeRect(tx, ty, tooltipWidth, tooltipHeight);

        // Text
        this.ctx.fillStyle = "#00ff88";
        this.ctx.textAlign = "left";
        this.ctx.textBaseline = "middle";

        this.ctx.fillText(
            text,
            tx + padding,
            ty + tooltipHeight / 2
        );
    }

    // show the text by default, but show 'hover' if the mouse is over the bar
    drawBar(line, event, hover) {
        assert(typeof event.name === "string", "event.name must be string");

        const color = getColor(this.color);
        this.color += 1;

        const bt = (event.begin_time - this.beginTime) / 1000;
        const et = (event.end_time - this.beginTime) / 1000;
        const durationMs = et - bt;

        const scale = 2;
        const x1 = Math.round(bt * scale);
        const x2 = Math.round(et * scale);

        //console.log("draw: y: " + line.y + " x1: " + x1 + " x2: " + x2);
        const width = x2 - x1;
        const isHovered = this.mouseX >= x1 && this.mouseX <= x2 && this.mouseY >= line.y && this.mouseY <= line.y + this.height;

        if (event.type === EventType.OPEN) {
            const gradient = this.ctx.createLinearGradient(x1, 0, x2, 0);
            gradient.addColorStop(0, color);
            gradient.addColorStop(0.75, color);
            gradient.addColorStop(1, "rgba(0,0,0,0)");

            this.ctx.fillStyle = gradient;
            this.ctx.fillRect(x1, line.y, width, this.height);
        }
        else {
            this.ctx.fillStyle = color;
            this.ctx.fillRect(x1, line.y, width, this.height);
        }

        if (isHovered) {
            //this.drawTextOnBar(hover, durationMs, x1 + width / 2, line.y + this.height / 2);
            this.drawTooltip(hover, durationMs);
        }
    }
}

class Scope {
    constructor(collector) {
        this.collector = collector;
        this.index = 0;
        this.canvas = document.createElement("canvas");
        this.canvas.classList.add("scope");

        this.mouseX = 0;
        this.mouseY = 0;

        this.canvas.addEventListener("mousemove", (e) => {
            const rect = this.canvas.getBoundingClientRect();
            this.mouseX = e.clientX - rect.left;
            this.mouseY = e.clientY - rect.top;
        });
    }

    element() {
        return this.canvas;
    }

    mount(parent) {
        this.parent = parent;
        if (!(parent instanceof HTMLElement)) {
            throw new TypeError("Scope: 'parent' must be a valid HTMLElement (is the name of the control correct?)");
        }
        this._build();
    }

    _build() {

        // this.speed = 67;
        // const control = new NumericControl({
        //     parent: this.parent,
        //     value: 10,
        //     step: 1,
        //     min: 0,
        //     max: 120,
        //     unit: "ms",
        //     onChange: (v) => {
        //         this.speed = v;
        //     }
        // });

        this.parent.appendChild(this.canvas);
        this.canvas.style.visibility = "visible";
    }

    render() {
        const ctx = this.canvas.getContext("2d");
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        const bars = new BarStack(ctx, this.mouseX, this.mouseY);
        const data = this.collector.data();

        for (const event of data) {
            const line = bars.getLine(event.groupId);
            if (event.end_time > line.lastEndTime) {
                line.lastEndTime = event.end_time;
            }

            if (event.type === EventType.OPEN) {
                line.openMap.set(event.name, event);

                if (event.begin_time < bars.beginTime) {
                    bars.beginTime = event.begin_time;
                }
            }

            if (event.type === EventType.CLOSE) {
                const entry = line.openMap.get(event.name);
                if (!entry) continue;
                const open = {
                    ...entry,   // take a copy
                    end_time: event.end_time,
                    type: EventType.CLOSE
                };
                line.closedEvents.push(open);
                line.openMap.delete(event.name);
            }

            if (event.type === EventType.DURATION) {
                line.closedEvents.push(event);
            }
        }

        bars.drawEvents();
    }

    resize(width, height) {
        const dpr = window.devicePixelRatio || 1;

        // Set the *displayed* size (CSS pixels)
        this.canvas.style.width = width + "px";
        this.canvas.style.height = height + "px";

        // Set the *actual* resolution (device pixels)
        this.canvas.width = Math.floor(width * dpr);
        this.canvas.height = Math.floor(height * dpr);

        // Scale drawing operations
        const ctx = this.canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
}
