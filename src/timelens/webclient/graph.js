import { EventType, getAudioAlerts } from "./globals.js";
import { getSettings } from "./globals.js";
import { BarStack } from "./barstack.js";

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

export class Graph {
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
        this.startPointUs = 0;      // timepoint where we start rendering the actual graph
        this.mouseInside = false;
        this.selectionStartX = null;
        this.selectionEndX = null;
        this.selecting = false;
        this.triggerWord = "";
        this.graphWidthMs = 1000;
        this.preTriggerMs = -10;

        // timepoint from where we are requesting information
        // after 'clear()' this will be non-zero because even through there is information in the
        // collector's data-buffer, we are only interested in the data after 'RequestStartPointUs'
        this.RequestStartPointUs = 0;

        this.canvas.addEventListener("mouseenter", () => {
            this.mouseInside = true;
        });

        this.canvas.addEventListener("mouseleave", () => {
            this.mouseInside = false;
        });

        this.canvas.addEventListener("mousedown", (e) => {
            if (e.button !== 0) {
                return;
            }

            const rect = this.canvas.getBoundingClientRect();
            this.selectionStartX = e.clientX - rect.left;
            this.selectionEndX = this.selectionStartX;
            this.selecting = true;
        });

        this.canvas.addEventListener("mousemove", (e) => {
            const rect = this.canvas.getBoundingClientRect();

            this.mouseX = e.clientX - rect.left;
            this.mouseY = e.clientY - rect.top;

            if (this.selecting) {
                this.selectionEndX = this.mouseX;
                this.render();
            }
        });

        this.canvas.addEventListener("mouseup", (e) => {
            if (e.button !== 0) {
                return;
            }

            if (this.selecting) {
                const rect = this.canvas.getBoundingClientRect();
                this.selectionEndX = e.clientX - rect.left;
                this.selecting = false;
                this.render();
            }
        });

        document.addEventListener("keydown", (e) => {
            this.keyHandler(e);
        });
    }

    keyHandler(e) {
        const key = e.key;
        if (key === "d") {
            getSettings().toggleDebuggingEnabled();
        }
        if (key === "r") {
            getSettings().toggleRandomSoundsEnabled();
        }
        if (key === "b") {
            getAudioAlerts().alertBeep();
        }
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

    drawCursor(ctx) {
        if (!this.mouseInside) {
            return;
        }

        const x = Math.round(this.mouseX) + 0.5;

        ctx.save();

        ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
        ctx.lineWidth = 1;

        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, this.graphHeightPx);
        ctx.stroke();

        ctx.restore();
    }

    drawSelection(ctx) {
        if (this.selectionStartX === null || this.selectionEndX === null) {
            return;
        }

        const x1 = Math.min(this.selectionStartX, this.selectionEndX);
        const x2 = Math.max(this.selectionStartX, this.selectionEndX);
        const width = x2 - x1;

        if (width <= 0) {
            return;
        }

        ctx.save();

        // Selection
        ctx.fillStyle = "rgba(100, 255, 160, 0.20)";
        ctx.fillRect(x1, 0, width, this.graphHeightPx);

        // Selection boundaries
        ctx.strokeStyle = "rgba(100, 255, 160, 0.8)";
        ctx.lineWidth = 1;

        ctx.beginPath();
        ctx.moveTo(x1 + 0.5, 0);
        ctx.lineTo(x1 + 0.5, this.graphHeightPx);
        ctx.moveTo(x2 + 0.5, 0);
        ctx.lineTo(x2 + 0.5, this.graphHeightPx);
        ctx.stroke();

        // Duration
        const durationUs = this.getSelectionDurationUs();
        const text = durationUs < 1000 ? `${durationUs.toFixed(0)} µs` : `${(durationUs / 1000).toFixed(3)} ms`;
        ctx.font = "12px monospace";

        const paddingX = 8;
        const metrics = ctx.measureText(text);

        const boxWidth = metrics.width + paddingX * 2;
        const boxHeight = 20;

        // Center the box inside the selection.
        const centerX = (x1 + x2) / 2;
        const boxX = centerX - boxWidth / 2;
        const boxY = (this.graphHeightPx - boxHeight) / 2;

        // Background
        ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
        ctx.fillRect(boxX, boxY, boxWidth, boxHeight);

        // Border
        ctx.strokeStyle = "rgba(100, 255, 160, 0.9)";
        ctx.strokeRect(
            boxX + 0.5,
            boxY + 0.5,
            boxWidth - 1,
            boxHeight - 1
        );

        // Text
        ctx.fillStyle = "#9affbd";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        ctx.fillText(
            text,
            centerX,
            boxY + boxHeight / 2
        );

        ctx.restore();
    }

    getSelectionDurationUs() {
        if (this.selectionStartX === null || this.selectionEndX === null) {
            return 0;
        }

        const x1 = Math.min(this.selectionStartX, this.selectionEndX);
        const x2 = Math.max(this.selectionStartX, this.selectionEndX);

        return (x2 - x1) * this.graphWidthUs / this.graphWidthPx;
    }

    setTriggerWord(triggerWord) {
        this.triggerWord = String(triggerWord);
    }

    getTriggerWord() {
        return this.triggerWord;
    }

    setgraphWidthMs(milliseconds) {
        const value = Number(milliseconds);

        if (Number.isFinite(value) && value > 0) {
            this.graphWidthMs = value;
        }
    }

    getGraphWidthMs() {
        return this.graphWidthMs;
    }

    setPreTrigger(milliseconds) {
        this.preTriggerMs = milliseconds;
    }

    getPreTriggerMs() {
        return this.preTriggerMs;
    }

    clear() {
        this.RequestStartPointUs = this.collector.getLastTimepointUs();
        this.render();
    }

    render() {
        const ctx = this.canvas.getContext("2d");
        if (!ctx) return

        this.renderGraph(ctx);
        this.drawSelection(ctx);
        this.drawCursor(ctx);
    }

    renderGraph(ctx) {

        const dpr = window.devicePixelRatio || 1; // dpr == 1.25 if your browser zoom is 125%
        this.graphWidthPx = this.canvas.width / dpr;
        this.graphHeightPx = this.canvas.height / dpr;
        ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr);

        const graphWidthMs = this.getGraphWidthMs();
        const preTriggerMs = this.getPreTriggerMs();

        // preTriggerMs < 0 will add to the width, while >= 0 will not affect the width
        const extraWidth = Math.max(preTriggerMs * -1, 0);
        this.zeroShiftUs = extraWidth * 1e3;
        this.graphWidthUs = ((graphWidthMs + extraWidth) * 1e3);
        this.startPointUs = this.collector.getLastTimepointUs() - this.graphWidthUs;
        this.drawGrid(ctx);

        const data = this.collector.data().filter(
            message => message.timestamp >= this.RequestStartPointUs
        );

        if (data.length === 0) {
            return;
        }
        this.RequestStartPointUs

        const triggerWord = this.getTriggerWord();
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
