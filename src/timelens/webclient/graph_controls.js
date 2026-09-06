//import { EventType } from "./collector.js";

class Widget {
    constructor({ parent, component, onClose }) {
        this.parent = parent;
        this.component = component;
        this.onClose = onClose;

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

        // Assemble
        this.container.appendChild(this.closeButton);
        this.component.mount(this.container);
        this.parent.appendChild(this.container);
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(this.container);
        this.resize();
    }

    resize() {
        const styles = window.getComputedStyle(this.container);
        const horizontalPadding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
        const verticalPadding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
        const width = Math.max(0, this.container.clientWidth - horizontalPadding);
        const height = Math.max(0, this.container.clientHeight - verticalPadding);

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

function getColor(c) {
    const hue = (c * 137.508) % 360;
    return `hsl(${hue}, 100%, 50%)`;
}

class Line {
    constructor(y) {
        this.y = y;
        this.height = 19;
        this.lineSpacing = 20;

        // Limitation: no support for nested events with the same name.
        this.openMap = new Map();
        this.closedEvents = [];

        this.lastEndTime = 0;

        // End time of the event currently occupying each lane.
        this.lanes = [];
    }

    getLane(beginTime) {
        for (let i = 0; i < this.lanes.length; ++i) {
            if (beginTime >= this.lanes[i]) {
                return i;
            }
        }

        this.lanes.push(0);
        return this.lanes.length - 1;
    }

    occupyLane(lane, endTime) {
        this.lanes[lane] = endTime;
    }

    getHeight() {
        return Math.max(1, this.lanes.length) * this.lineSpacing;
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
        this.hover = null;
    }

    getLine(id) {
        let entry = this.lines.get(id);
        if (!entry) {
            entry = this.makeLine();
            this.lines.set(id, entry);
        }
        return entry;
    }

    makeLine() {
        const line = new Line(this.y);
        return line;
    }

    layoutLine(line) {
        const events = [];

        for (const event of line.closedEvents) {
            events.push(event);
        }

        for (const event of line.openMap.values()) {
            events.push({ ...event, end_time: line.lastEndTime });
        }

        events.sort((a, b) => a.begin_time - b.begin_time);

        line.lanes = [];

        for (const event of events) {
            const lane = line.getLane(event.begin_time);
            line.occupyLane(lane, event.end_time);
            event.lane = lane;
        }
    }

    layout() {
        let y = 20;

        for (const [, line] of this.lines) {
            line.y = y;
            this.layoutLine(line);
            y += line.getHeight();
        }
    }

    drawEvent(line, event) {
        const y = line.y + event.lane * line.lineSpacing;
        this.drawBar(line, event, event.name, y);
    }

    drawEvents() {
        this.layout();

        for (const [, line] of this.lines) {
            const unclosedEvents = Array.from(line.openMap.values());

            for (const event of unclosedEvents) {
                const drawEvent = {
                    ...event,
                    end_time: line.lastEndTime
                };

                const lane = line.getLane(drawEvent.begin_time);
                line.occupyLane(lane, drawEvent.end_time);
                drawEvent.lane = lane;
                this.drawEvent(line, drawEvent);
            }

            for (const event of line.closedEvents) {
                this.drawEvent(line, event);
            }
        }
        // Draw the tooltip last so it is always on top.
        if (this.hover) {
            this.drawTooltip(this.hover.name, this.hover.duration);
        }
    }

    drawTextOnBar(hover, duration, x, y) {
        this.ctx.fillStyle = "black";
        this.ctx.font = "10px monospace";
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "middle";
        this.ctx.fillText(`${hover} (${duration.toFixed(3)} ms)`, x, y
        );
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
        this.ctx.strokeStyle = "#00ff88";
        this.ctx.strokeRect(tx, ty, tooltipWidth, tooltipHeight);
        this.ctx.fillStyle = "#00ff88";
        this.ctx.textAlign = "left";
        this.ctx.textBaseline = "middle";
        this.ctx.fillText(text, tx + padding, ty + tooltipHeight / 2);
    }

    // Show the text by default, but show 'hover' if the mouse is over the bar.
    drawBar(line, event, hover, y) {
        assert(typeof event.name === "string", "event.name must be string");

        const color = getColor(this.color);
        this.color += 1;

        const bt = (event.begin_time - this.beginTime) / 1000;
        const et = (event.end_time - this.beginTime) / 1000;
        const durationMs = et - bt;

        const scale = 25;
        const x1 = Math.round(bt * scale);
        const x2 = Math.round(et * scale);

        const width = x2 - x1;

        const isHovered =
            this.mouseX >= x1 &&
            this.mouseX <= x2 &&
            this.mouseY >= y &&
            this.mouseY <= y + line.height;

        if (event.type === EventType.OPEN) {
            const gradient = this.ctx.createLinearGradient(x1, 0, x2, 0);
            gradient.addColorStop(0, color);
            gradient.addColorStop(0.75, color);
            gradient.addColorStop(1, "rgba(0,0,0,0)");

            this.ctx.fillStyle = gradient;
            this.ctx.fillRect(x1, y, width, line.height);
        }
        else {
            this.ctx.fillStyle = color;
            this.ctx.fillRect(x1, y, width, line.height);
        }

        if (isHovered) {
            this.hover = { name: hover, duration: durationMs };
        }
    }
}

class Graph {
    constructor(collector) {
        this.collector = collector;
        this.index = 0;
        this.canvas = document.createElement("canvas");
        this.canvas.classList.add("graph");

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
            throw new TypeError("Graph: 'parent' must be a valid HTMLElement (is the name of the control correct?)");
        }
        this._build();
    }

    _build() {
        this.parent.appendChild(this.canvas);
        this.canvas.style.visibility = "visible";
    }

    findTriggerIndex(data) {
        let startIndex = 0;
        const triggerWord = this.collector.getTriggerWord();
        if (triggerWord) {
            for (let i = data.length - 1; i >= 0; --i) {
                const event = data[i];
                if (event.type !== EventType.OPEN)
                    continue;
                if (containsIgnoreCase(event.name, triggerWord)) {
                    startIndex = i;
                    break;
                }
            }
        }
        return startIndex;
    }

    drawGrid(ctx) {
        const dpr = window.devicePixelRatio || 1;
        const width = this.canvas.width / dpr;
        const height = this.canvas.height / dpr;

        ctx.save();
        ctx.lineWidth = 1;

        for (let x = 0; x <= width; x += 50) {
            const isMajorLine = x % 100 === 0;
            ctx.strokeStyle = isMajorLine
                ? "rgba(52, 229, 189, 0.16)"
                : "rgba(142, 161, 189, 0.08)";
            ctx.beginPath();
            ctx.moveTo(x + 0.5, 0);
            ctx.lineTo(x + 0.5, height);
            ctx.stroke();
        }

        for (let y = 0; y <= height; y += 20) {
            ctx.strokeStyle = "rgba(142, 161, 189, 0.08)";
            ctx.beginPath();
            ctx.moveTo(0, y + 0.5);
            ctx.lineTo(width, y + 0.5);
            ctx.stroke();
        }

        ctx.restore();
    }

    render() {
        const ctx = this.canvas.getContext("2d");
        const dpr = window.devicePixelRatio || 1;
        ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr);
        this.drawGrid(ctx);

        const bars = new BarStack(ctx, this.mouseX, this.mouseY);
        const data = this.collector.data();

        let startIndex = this.findTriggerIndex(data);
        for (let i = startIndex; i < data.length; ++i) {
            const event = data[i];
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
