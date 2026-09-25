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
    constructor(ctx, mouseX, mouseY, pixelsPerMicrosecond, startPointUs, endPointUs) {
        this.ctx = ctx;
        this.mouseX = mouseX;
        this.mouseY = mouseY;
        this.scale = pixelsPerMicrosecond;
        this.startPointUs = startPointUs;
        this.endPointUs = endPointUs;

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
        const sortedLines = [...this.lines.entries()].sort(([a], [b]) => a - b);
        for (const [, line] of sortedLines) {
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

        const sortedLines = [...this.lines.entries()].sort(([a], [b]) => a - b);

        for (const [, line] of sortedLines) {
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

        const durationMs = (event.end_time - event.timestamp) / 1000;
        const x1 = Math.round((event.timestamp - this.startPointUs) * this.scale);
        let x2 = Math.round((event.end_time - this.startPointUs) * this.scale);
        let width = x2 - x1;

        const color = getColor(event.name);
        if (event.type === EventType.OPEN) {
            x2 = Math.round((this.endPointUs - this.startPointUs) * this.scale);
            width = x2 - x1;
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

        if (getSettings().isDebuggingEnabled()) {
            this.drawTextOnBar(`${event.count} = ${event.name} of ${durationMs} ms`, x1, width, y, line.height);
        }
        else {
            this.drawTextOnBar(`${event.name} of ${durationMs} ms`, x1, width, y, line.height);
        }

        const isHovered =
            this.mouseX >= x1 &&
            this.mouseX <= x2 &&
            this.mouseY >= y &&
            this.mouseY <= y + line.height;

        if (isHovered) {
            this.hover = { name: hover, duration: durationMs };
        }
    }
}
