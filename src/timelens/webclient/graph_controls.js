//import { EventType } from "./collector.js";

/**
 * A container that wraps a component and provides resize and close behavior.
 * It can be styled in the css.
 */
class ResizableContainer {
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

function containsIgnoreCaseWildcard(text, search) {
    const lowerText = text.toLowerCase();
    const lowerSearch = search.toLowerCase();

    if (!lowerSearch.includes("*")) {
        return lowerText.includes(lowerSearch);
    }

    const parts = lowerSearch.split("*");
    const startsWithWildcard = lowerSearch.startsWith("*");
    const endsWithWildcard = lowerSearch.endsWith("*");

    let position = 0;

    for (const part of parts) {
        if (!part) {
            continue;
        }

        const found = lowerText.indexOf(part, position);

        if (found === -1) {
            return false;
        }

        position = found + part.length;
    }

    if (!startsWithWildcard && !lowerText.startsWith(parts[0])) {
        return false;
    }

    if (!endsWithWildcard && !lowerText.endsWith(parts[parts.length - 1])) {
        return false;
    }

    return true;
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

    getLane(timestamp) {
        for (let i = 0; i < this.lanes.length; ++i) {
            if (timestamp >= this.lanes[i]) {
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
    constructor(ctx, mouseX, mouseY, pixelsPerMicrosecond, startPointUs, endPointUs) {
        this.ctx = ctx;
        this.mouseX = mouseX;
        this.mouseY = mouseY;
        this.scale = pixelsPerMicrosecond;
        this.startPointUs = startPointUs;
        this.endPointUs = endPointUs;

        this.color = 1;
        this.y = 0;
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

        events.sort((a, b) => a.timestamp - b.timestamp);

        line.lanes = [];

        for (const event of events) {
            const lane = line.getLane(event.timestamp);
            line.occupyLane(lane, event.end_time);
            event.lane = lane;
        }
    }

    layout() {
        let y = 0;
        for (const [, line] of this.lines) {
            line.y = y;
            this.layoutLine(line);
            y += line.getHeight();
        }
    }

    formatTimestamp(time) {
        const seconds = Math.floor(time / 1_000_000);
        const milliseconds = Math.floor((time % 1_000_000) / 1_000);
        const microseconds = time % 1_000;

        if (seconds > 0) {
            return `${seconds}s ${milliseconds}ms ${microseconds}us:`;
        }

        return `${milliseconds}ms ${microseconds}us:`;
    }

    drawEvent(line, event) {
        const y = line.y + event.lane * line.lineSpacing;
        const hover = `${this.formatTimestamp(event.timestamp)} ${event.name}`
        this.drawBar(line, event, hover, y);
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

                const lane = line.getLane(drawEvent.timestamp);
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

    drawTextOnBar(name, x, width, y, height) {

        // console.log(`draw: ${name}: ${x},${y} ${width}x${height}`)
        const horizontalPadding = 4;
        const availableWidth = width - horizontalPadding * 2;

        if (availableWidth <= 0) {
            return;
        }

        this.ctx.font = "14px monospace";
        let text = name;

        if (this.ctx.measureText(text).width > availableWidth) {
            text = `${name.slice(0, 3)}...`;

            if (this.ctx.measureText(text).width > availableWidth) {
                return;
            }
        }

        this.ctx.fillStyle = "#07131f";
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "middle";
        const dpr = window.devicePixelRatio || 1;
        const snapToPixel = (value) => Math.round(value * dpr) / dpr;
        this.ctx.fillText(
            text,
            snapToPixel(x + width / 2),
            snapToPixel(y + height / 2)
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

        // Position near the mouse, but keep the tooltip inside the graph.
        const dpr = window.devicePixelRatio || 1;
        const canvasWidth = this.ctx.canvas.width / dpr;
        const canvasHeight = this.ctx.canvas.height / dpr;

        const tx = Math.max(0, Math.min(this.mouseX + 12, canvasWidth - tooltipWidth));
        const ty = Math.max(0, Math.min(this.mouseY - 24, canvasHeight - tooltipHeight));

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


    // Show the text by default, but show 'hover' if the mouse is over the bar.
    drawBar(line, event, hover, y) {
        assert(typeof event.name === "string", "event.name must be string");

        const color = getColor(this.color);
        this.color += 1;

        const durationMs = (event.end_time - event.timestamp) / 1000;
        const x1 = Math.round((event.timestamp - this.startPointUs) * this.scale);
        const x2 = Math.round((event.end_time - this.startPointUs) * this.scale);
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

        this.drawTextOnBar(event.name, x1, width, y, line.height);

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
        this.graphWidthPx = 0;
        this.graphHeightPx = 0;
        this.zeroShiftUs = 0;
        this.graphWidthUs = 0;
        this.startPointUs = 0;

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

    findTriggerIndex(data, triggerWord) {
        const index = data.findLastIndex(event =>
            event.type === EventType.OPEN &&
            containsIgnoreCaseWildcard(event.name, triggerWord));
        return index >= 0 ? index : undefined;
    }

    findStartIndex(data, time) {
        const index = data.findIndex(event => event.timestamp >= time);
        return index >= 0 ? index : 0;
    }

    toLocalX(timeUs) {
        // A 1-pixel line drawn at an integer coordinate can land between physical pixels, causing the browser to anti-alias it and make it look blurry.
        // Using +0.5 centers the 1px stroke on a physical pixel column, giving a sharper line.
        const renderAdjustment = 0.5;
        const t = timeUs - this.startPointUs;
        return renderAdjustment + Math.round((this.graphWidthPx / this.graphWidthUs) * t);
    }

    // the grid divides the (graphWidth - zeroShift) into 20 segements
    // the majorLine aligns with the zero-point
    drawGrid(ctx) {
        ctx.save();
        ctx.lineWidth = 1;

        const minorGridLineCount = 20;
        const stepUs = (this.graphWidthUs - this.zeroShiftUs) / minorGridLineCount;
        const endPoint = this.startPointUs + this.graphWidthUs;
        const zeroPointUs = this.startPointUs + this.zeroShiftUs;

        const drawVerticalLine = (t, index) => {
            const x = this.toLocalX(t);
            const isMajorLine = index % 2 === 0;

            ctx.strokeStyle = isMajorLine
                ? "rgba(52, 229, 189, 0.26)"
                : "rgba(142, 161, 189, 0.18)";

            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, this.graphHeightPx);
            ctx.stroke();
        };

        // lines before zero
        for (let index = 0, t = zeroPointUs; t > this.startPointUs; t -= stepUs, ++index) {
            drawVerticalLine(t, index);
        }

        // lines after zero
        for (let index = 0, t = zeroPointUs; t < endPoint; t += stepUs, ++index) {
            drawVerticalLine(t, index);
        }

        const renderAdjustment = 0.5;
        for (let y = 0; y <= this.graphHeightPx; y += 20) {
            ctx.strokeStyle = "rgba(142, 161, 189, 0.08)";
            ctx.beginPath();
            ctx.moveTo(0, y + renderAdjustment);
            ctx.lineTo(this.graphWidthPx, y + renderAdjustment);
            ctx.stroke();
        }

        const zeroX = this.toLocalX(zeroPointUs);
        ctx.fillStyle = "white";

        // Top marker
        ctx.beginPath();
        ctx.moveTo(zeroX - 5, 0);
        ctx.lineTo(zeroX + 5, 0);
        ctx.lineTo(zeroX, 6);
        ctx.closePath();
        ctx.fill();

        // Bottom marker
        ctx.beginPath();
        ctx.moveTo(zeroX - 5, this.graphHeightPx);
        ctx.lineTo(zeroX + 5, this.graphHeightPx);
        ctx.lineTo(zeroX, this.graphHeightPx - 6);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    render() {
        const ctx = this.canvas.getContext("2d");
        if (!ctx) return

        const dpr = window.devicePixelRatio || 1; // dpr == 1.25 if your browser zoom is 125%
        this.graphWidthPx = this.canvas.width / dpr;
        this.graphHeightPx = this.canvas.height / dpr;
        ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr);

        const graphWidthMs = this.collector.getGraphWidthMs();
        const graphOffsetMs = this.collector.getGraphOffsetMs();

        // graphOffsetMs < 0 will add to the width, while >= 0 will not affect the width
        const extraWidth = Math.max(graphOffsetMs * -1, 0);
        this.zeroShiftUs = extraWidth * 1e3;
        this.graphWidthUs = ((graphWidthMs + extraWidth) * 1e3);
        this.startPointUs = this.collector.getLastTimepointUs() - this.graphWidthUs;
        this.drawGrid(ctx);

        const data = this.collector.data();
        if (data.length === 0) {
            return;
        }

        const triggerWord = this.collector.getTriggerWord();
        if (triggerWord) {
            const triggerIndex = this.findTriggerIndex(data, triggerWord);
            if (triggerIndex === undefined) {
                // trigger specified, but not found.
                return;
            }
            this.startPointUs = data[triggerIndex].timestamp - this.zeroShiftUs // new startpoint
        }
        const startIndex = this.findStartIndex(data, this.startPointUs);
        const estimatedNow = this.collector.estimateNowUs();
        const maxEnd = this.startPointUs + this.graphWidthUs;
        const endPointUs = Math.min(estimatedNow, maxEnd);

        const bars = new BarStack(
            ctx,
            this.mouseX,
            this.mouseY,
            this.graphWidthPx / this.graphWidthUs,
            this.startPointUs,
            endPointUs
        );

        for (let i = startIndex; i < data.length; ++i) {
            const event = data[i];
            const line = bars.getLine(event.groupId);
            if (event.timestamp > line.lastEndTime) {
                line.lastEndTime = event.timestamp;
            }

            if (event.type === EventType.OPEN) {
                line.openMap.set(event.name, event);

                if (event.timestamp < bars.beginTime) {
                    bars.beginTime = event.timestamp;
                }
            }

            if (event.type === EventType.CLOSE) {
                const start_event = line.openMap.get(event.name);
                if (!start_event) continue;
                const closedEvent = {
                    ...start_event,   // take a copy
                    end_time: event.timestamp,          // closedEvent now has timestamp + end_time
                    type: EventType.CLOSE
                };
                line.closedEvents.push(closedEvent);
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
        const pixelWidth = Math.round(width * dpr);
        const pixelHeight = Math.round(height * dpr);
        const displayWidth = pixelWidth / dpr;
        const displayHeight = pixelHeight / dpr;

        // Keep the displayed size aligned with the backing-store pixel grid.
        this.canvas.style.width = displayWidth + "px";
        this.canvas.style.height = displayHeight + "px";

        // Set the *actual* resolution (device pixels)
        this.canvas.width = pixelWidth;
        this.canvas.height = pixelHeight;

        // Scale drawing operations
        const ctx = this.canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
}
