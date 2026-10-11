import { assert } from "./assertions.js";
import { EventType } from "./globals.js";
import { getSettings } from "./globals.js";

// An event that has not ended is drawn as long as this fraction of the time that it is estimated to be open.
const openEventFraction = 0.5;

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

/** Whether the point is in the rectangle, which can be 'slack' pixels bigger on every side. */
export function isInside(x, y, rect, slack = 0) {
    return x >= rect.x - slack && x <= rect.x + rect.width + slack && y >= rect.y - slack && y <= rect.y + rect.height + slack;
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

        // The tooltip from the previous frame, positioned at the end of the bar it belonged to.
        // Keep it visible while the mouse is over it and briefly after the mouse leaves,
        // allowing the mouse to reach the icon inside it. See drawEvents() and keepPreviousTooltip.
        // Populated by the caller.
        this.previousTooltip = null;
        this.keepPreviousTooltip = false;
        this.mouseInside = true;            // false when the mouse is not over the graph
        /** @type {"copied" | "failed" | null} */
        this.copyFeedback = null;           // what the icon shows for a moment after it was pressed

        /**
         * The tooltip currently displayed in the graph, used for mouse hit-testing.
          * All coordinates are relative to the graph area. Null if no tooltip was drawn.
         * @type {{x: number, y: number, width: number, height: number, text: string, hover: {event: import("./globals.js").TSEvent, durationUs: number},
         *         icon: {x: number, y: number, width: number, height: number}, pinned: boolean} | null}
         */
        this.tooltip = null;
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
        //
        // The tooltip follows the mouse, which gives no way to press the icon in it: it would run away from the mouse. So the
        // tooltip of the previous frame stays where it is while the mouse is in it, also over other bars. When the mouse has
        // left the bar it was for, it stays for a moment, which is the time to move to it.
        const previous = this.previousTooltip;
        const pinned = previous ? { x: previous.x, y: previous.y } : null;
        if (previous && this.mouseInside && isInside(this.mouseX, this.mouseY, previous, 4)) {
            this.drawTooltip(previous.hover, pinned);
        }
        else if (this.hover) {
            this.drawTooltip(this.hover);
        }
        else if (previous && this.keepPreviousTooltip) {
            this.drawTooltip(previous.hover, pinned);
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

    /**
     * @param {{event: any, durationUs: number}} hover
     * @param {{x: number, y: number} | null} [position]  where the tooltip stays, instead of following the mouse
     */
    drawTooltip(hover, position = null) {
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

        // the statistics of all events with this name, apart from the other lines: see below
        const statLines = [];
        const stats = this.durationStats.get(event.name);
        if (stats && stats.count > 0) {
            // sample standard deviation, undefined for a single sample
            const stddev = stats.count > 1 ? this.formatDuration(Math.sqrt(stats.m2 / (stats.count - 1))) : "-";
            statLines.push(
                { text: `samples:  ${stats.count}`, ...textFont },
                { text: `min:      ${this.formatDuration(stats.min)}`, ...textFont },
                { text: `max:      ${this.formatDuration(stats.max)}`, ...textFont },
                { text: `avg:      ${this.formatDuration(stats.mean)}`, ...textFont },
                { text: `stddev:   ${stddev} (sample)`, ...textFont }
            );
        }

        const padding = 8;
        const columnGap = 16;
        const dpr = window.devicePixelRatio || 1;
        const canvasWidth = this.areaWidthPx ?? this.ctx.canvas.width / dpr;
        const canvasHeight = this.areaHeightPx ?? this.ctx.canvas.height / dpr;

        const heightOf = (/** @type {Array<{height: number}>} */ column) => column.reduce((height, line) => height + line.height, 0);
        const widthOf = (/** @type {Array<{font: string, text: string}>} */ column) => Math.max(...column.map(line => {
            this.ctx.font = line.font;
            return this.ctx.measureText(line.text).width;
        }));

        // The statistics are the last lines, a tooltip that does not fit in the graph is cut off at the bottom and they
        // would be gone: then they get a column of their own, next to the other lines.
        const oneColumn = [...lines, ...statLines];
        const columns = heightOf(oneColumn) + padding <= canvasHeight || statLines.length === 0 ? [oneColumn] : [lines, statLines];

        // the icon that copies the text is in the top right corner, the title does not run into it
        const iconSize = 14;
        const iconGap = 8;

        const columnWidths = columns.map(widthOf);
        const tooltipWidth = columnWidths.reduce((sum, width) => sum + width, 0) + columnGap * (columns.length - 1) + padding * 2 + iconGap + iconSize;
        const tooltipHeight = Math.max(...columns.map(heightOf)) + padding;

        // Position near the mouse, but keep the tooltip inside the graph. A tooltip that stays is where it was.
        const wantedX = position ? position.x : this.mouseX + 12;
        const wantedY = position ? position.y : this.mouseY - 24;
        const tx = Math.max(0, Math.min(wantedX, canvasWidth - tooltipWidth));
        const ty = Math.max(0, Math.min(wantedY, canvasHeight - tooltipHeight));

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
        let columnX = tx + padding;
        columns.forEach((column, index) => {
            let lineY = ty + padding / 2;
            for (const line of column) {
                this.ctx.font = line.font;
                this.ctx.fillText(line.text, columnX, lineY + line.height / 2);
                lineY += line.height;
            }
            columnX += columnWidths[index] + columnGap;
        });

        // The icon, in line with the title.
        const icon = { x: tx + tooltipWidth - padding - iconSize, y: ty + padding / 2 + (titleFont.height - iconSize) / 2, width: iconSize, height: iconSize };
        this.drawCopyIcon(icon);

        // all that is shown, one line each, is what the icon copies
        this.tooltip = {
            x: tx, y: ty, width: tooltipWidth, height: tooltipHeight, text: oneColumn.map(line => line.text).join("\n"),
            hover, icon, pinned: position !== null
        };
    }

    // The icon to copy the tooltip with: two sheets of paper. After it was pressed, a check mark or a cross for a moment.
    drawCopyIcon({ x, y, width: size }) {
        const ctx = this.ctx;
        const over = this.mouseInside && isInside(this.mouseX, this.mouseY, { x, y, width: size, height: size }, 3);

        ctx.save();
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        if (this.copyFeedback === "copied") {
            ctx.strokeStyle = "#00ff88";
            ctx.lineWidth = 2.4;
            ctx.beginPath();
            ctx.moveTo(x + 2, y + size / 2 + 1);
            ctx.lineTo(x + size * 0.4, y + size - 3);
            ctx.lineTo(x + size - 2, y + 3);
            ctx.stroke();
        }
        else if (this.copyFeedback === "failed") {
            ctx.strokeStyle = "#ff5577";
            ctx.lineWidth = 2.4;
            ctx.beginPath();
            ctx.moveTo(x + 3, y + 3);
            ctx.lineTo(x + size - 3, y + size - 3);
            ctx.moveTo(x + size - 3, y + 3);
            ctx.lineTo(x + 3, y + size - 3);
            ctx.stroke();
        }
        else {
            ctx.strokeStyle = over ? "#ffffff" : "#00ff88";
            ctx.globalAlpha = over ? 1 : 0.75;
            ctx.lineWidth = 1.4;
            const sheet = size - 4;
            ctx.strokeRect(x + 4.5, y + 0.5, sheet - 1, sheet - 1);         // the sheet behind
            ctx.fillStyle = "rgba(0, 0, 0, 0.95)";                          // the sheet in front hides the corner of the one behind
            ctx.fillRect(x + 0.5, y + 4.5, sheet - 1, sheet - 1);
            ctx.strokeRect(x + 0.5, y + 4.5, sheet - 1, sheet - 1);
        }
        ctx.restore();
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
            // The event grows up to the estimated time, but is drawn only half as long: the end of an
            // event can arrive late, and a bar that is drawn too long would shrink when it does.
            const estimatedUs = Math.max(0, this.endPointUs - event.timestamp);
            const barEndUs = event.timestamp + estimatedUs * openEventFraction;
            x2 = Math.round((barEndUs - this.startPointUs) * this.scale);
            width = x2 - x1;
            durationUs = estimatedUs;       // the hover shows how long it has been open, as far as we know
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
