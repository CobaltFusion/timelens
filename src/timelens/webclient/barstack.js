import { assert } from "./assertions.js";
import { EventType } from "./globals.js";
import { getSettings } from "./globals.js";

class Line {
    constructor(y) {
        this.y = y;
        this.height = 19;
        this.lineSpacing = 20;

        // Limitation: no support for nested events with the same name.
        this.openMap = new Map();
        this.closedEvents = [];

        this.lastEndTime = 0;

        /** @type {number | undefined} the pid of the first event of this row, the row itself is a tid */
        this.processId = undefined;

        // End time of the event currently occupying each lane.
        this.lanes = [];

        // All events (closed and still open) with their assigned lane, in draw order.
        this.layoutEvents = [];
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

function getColor(name) {
    let c = 0;

    for (let i = 0; i < name.length; ++i) {
        c = ((c << 5) - c) + name.charCodeAt(i);
        c |= 0;
    }

    c = Math.abs(c);
    const hue = (c * 137.508) % 360;
    return `hsl(${hue}, 80%, 65%)`;
}

export class BarStack {
    constructor(ctx, mouseX, mouseY, pixelsPerMicrosecond, startPointUs, endPointUs, zeroPointUs) {
        this.ctx = ctx;
        this.mouseX = mouseX;
        this.mouseY = mouseY;
        this.scale = pixelsPerMicrosecond;
        this.startPointUs = startPointUs;
        this.endPointUs = endPointUs;
        this.zeroPointUs = zeroPointUs;

        this.y = 0;
        this.height = 12;
        this.lines = new Map();
        this.beginTime = Infinity;
        this.hover = null;   // the hover shows the offset from the zero-point
        this.durationStats = new Map();   // name -> { count, min, max, mean, m2 }, filled by the caller
        /** @type {{ getProcessName(pid: number): string | undefined, getThreadName(pid: number, tid: number): string | undefined }} */
        this.names = { getProcessName: () => undefined, getThreadName: () => undefined };   // filled by the caller
        this.areaWidthPx = undefined;
        this.areaHeightPx = undefined;
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

        // drawn as laid out, so an event keeps its lane when it goes from open to closed
        line.layoutEvents = events;
    }

    layout() {
        let y = 0;
        const sortedLines = [...this.lines.entries()].sort(([a], [b]) => a - b);
        for (const [, line] of sortedLines) {
            line.y = y;
            this.layoutLine(line);
            y += line.getHeight();
        }
    }

    // Picks s, ms or µs so the number stays readable.
    formatDuration(durationUs) {
        const absoluteUs = Math.abs(durationUs);
        if (absoluteUs >= 1_000_000) {
            return `${(durationUs / 1_000_000).toFixed(3)} s`;
        }
        if (absoluteUs >= 1_000) {
            return `${(durationUs / 1_000).toFixed(3)} ms`;
        }
        return `${durationUs.toFixed(0)} µs`;
    }

    formatWallTime(timeMs) {
        if (timeMs === undefined) {
            return "-";
        }
        const date = new Date(timeMs);
        const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
        return `${date.toLocaleTimeString([], { hour12: false })}.${milliseconds}`;
    }

    drawEvent(line, event) {
        const y = line.y + event.lane * line.lineSpacing;
        this.drawBar(line, event, y);
    }

    drawEvents() {
        this.layout();

        const sortedLines = [...this.lines.entries()].sort(([a], [b]) => a - b);

        for (const [, line] of sortedLines) {
            for (const event of line.layoutEvents) {
                this.drawEvent(line, event);
            }
        }
        // Draw the tooltip last so it is always on top.
        if (this.hover) {
            this.drawTooltip(this.hover);
        }
    }

    drawTextOnBar(name, x, width, y, height, durationUs) {

        // Bars this narrow can't show anything readable, so skip measuring text for them.
        const minimumTextBarWidth = 20;
        if (width < minimumTextBarWidth) {
            return;
        }

        const horizontalPadding = 4;
        const availableWidth = width - horizontalPadding * 2;

        this.ctx.font = "14px monospace";

        const texts = [
            `${name} (${this.formatDuration(durationUs)})`,
            `${name}`,
            `${name.slice(0, 3)}...`
        ];

        const text = texts.find(
            text => this.ctx.measureText(text).width <= availableWidth
        );

        if (!text) {
            return;
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

    // " (name)" to show behind a pid or tid, nothing without a name
    nameSuffix(name) {
        return name ? ` (${name})` : "";
    }

    drawTooltip(hover) {
        const event = hover.event;
        const offsetMs = (event.timestamp - this.zeroPointUs) / 1000;

        const titleFont = { font: "bold 16px monospace", height: 22 };
        const textFont = { font: "13px monospace", height: 17 };
        const lines = [
            { text: event.name, ...titleFont },
            { text: `offset:   ${offsetMs.toFixed(3)} ms`, ...textFont },
            { text: `duration: ${this.formatDuration(hover.durationUs)}${event.type === EventType.OPEN ? " (open)" : ""}`, ...textFont },
            { text: `received: ${this.formatWallTime(event.receivedMs)}`, ...textFont },
            { text: `pid:      ${event.processId ?? "-"}${this.nameSuffix(this.names.getProcessName(event.processId))}`, ...textFont },
            { text: `tid:      ${event.groupId ?? "-"}${this.nameSuffix(this.names.getThreadName(event.processId, event.groupId))}`, ...textFont }
        ];

        const stats = this.durationStats.get(event.name);
        if (stats && stats.count > 0) {
            // sample standard deviation, undefined for a single sample
            const stddev = stats.count > 1 ? this.formatDuration(Math.sqrt(stats.m2 / (stats.count - 1))) : "-";
            lines.push(
                { text: `samples:  ${stats.count}`, ...textFont },
                { text: `min:      ${this.formatDuration(stats.min)}`, ...textFont },
                { text: `max:      ${this.formatDuration(stats.max)}`, ...textFont },
                { text: `avg:      ${this.formatDuration(stats.mean)}`, ...textFont },
                { text: `stddev:   ${stddev} (sample)`, ...textFont }
            );
        }

        // Measure text size
        const padding = 8;
        const textWidth = Math.max(...lines.map(line => {
            this.ctx.font = line.font;
            return this.ctx.measureText(line.text).width;
        }));

        const tooltipWidth = textWidth + padding * 2;
        const tooltipHeight = lines.reduce((height, line) => height + line.height, 0) + padding;

        // Position near the mouse, but keep the tooltip inside the graph.
        const dpr = window.devicePixelRatio || 1;
        const canvasWidth = this.areaWidthPx ?? this.ctx.canvas.width / dpr;
        const canvasHeight = this.areaHeightPx ?? this.ctx.canvas.height / dpr;

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
        let lineY = ty + padding / 2;
        for (const line of lines) {
            this.ctx.font = line.font;
            this.ctx.fillText(line.text, tx + padding, lineY + line.height / 2);
            lineY += line.height;
        }
    }

    // Draws the bar with its text, and remembers it for the tooltip if the mouse is over it.
    drawBar(line, event, y) {
        assert(typeof event.name === "string", "event.name must be string");

        let durationUs = event.end_time - event.timestamp;
        const x1 = Math.round((event.timestamp - this.startPointUs) * this.scale);
        let x2 = Math.round((event.end_time - this.startPointUs) * this.scale);
        let width = x2 - x1;

        const color = event.color ?? getColor(event.name);
        if (event.type === EventType.OPEN) {
            x2 = Math.round((this.endPointUs - this.startPointUs) * this.scale);
            width = x2 - x1;
            durationUs = this.endPointUs - event.timestamp;
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

        // A bar can start before the left edge or end after the right edge of the graph, only the part
        // that is visible can show text: it is measured and centered within that part.
        const visibleX1 = Math.max(x1, 0);
        const visibleX2 = Math.min(x2, this.areaWidthPx ?? Infinity);
        const visibleWidth = visibleX2 - visibleX1;

        if (getSettings().isDebuggingEnabled()) {
            this.drawTextOnBar(`${event.count} = ${event.name}`, visibleX1, visibleWidth, y, line.height, durationUs);
        }
        else {
            this.drawTextOnBar(`${event.name}`, visibleX1, visibleWidth, y, line.height, durationUs);
        }

        const isHovered =
            this.mouseX >= x1 &&
            this.mouseX <= x2 &&
            this.mouseY >= y &&
            this.mouseY <= y + line.height;

        if (isHovered) {
            this.hover = { event, durationUs, x1, x2 };
        }
    }
}
