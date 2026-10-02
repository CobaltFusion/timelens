import { EventType, roundUpNice } from "./globals.js";
import { BarStack } from "./barstack.js";
import { TriggerSource } from "./trigger_source.js";

export class Graph {
    constructor(collector) {
        this.collector = collector;
        this.triggerSource = new TriggerSource(collector);
        this.index = 0;
        this.canvas = document.createElement("canvas");
        this.canvas.classList.add("graph");
        this.mouseX = 0;
        this.mouseY = 0;
        this.marginPx = 8;          // invisible margin around the graph area, holds the zero-point markers
        this.graphWidthPx = 0;      // size of the graph area, excluding the margin
        this.graphHeightPx = 0;
        this.zeroShiftUs = 0;
        this.graphWidthUs = 0;
        this.startPointUs = 0;      // timepoint where we start rendering the actual graph
        this.mouseInside = false;
        this.shiftHeld = false;     // while held, the cursor snaps to the begin or end of the hovered event
        this.hoveredBar = null;     // { x1, x2 } of the event under the mouse, from the last render
        this.selectionStartX = null;
        this.selectionEndX = null;
        this.selecting = false;
        this.triggerWord = "";
        this.graphWidthMs = 1000;
        this.onStatusChanged = null;

        // Manual view (pan/zoom with the keyboard): while active, incoming events are
        // ignored and the graph shows a snapshot of the data until resume() is called.
        this.manualView = null;     // { data, startUs, widthUs, zeroPointUs, nowUs, baseStepUs }

        this.triggerSource.onStatusChanged = () => {
            this.onStatusChanged?.();
        };

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

            this.mouseX = this.#toGraphX(e);
            this.shiftHeld = e.shiftKey;
            this.selectionStartX = this.getCursorX();
            this.selectionEndX = this.selectionStartX;
            this.selecting = true;
        });

        this.canvas.addEventListener("mousemove", (e) => {
            this.mouseX = this.#toGraphX(e);
            this.mouseY = this.#toGraphY(e);
            this.shiftHeld = e.shiftKey;

            if (this.selecting) {
                this.render();      // render() updates selectionEndX
            }
        });

        // shift can be pressed or released without moving the mouse
        window.addEventListener("keydown", (e) => {
            if (e.key === "Shift") {
                this.shiftHeld = true;
            }
        });
        window.addEventListener("keyup", (e) => {
            if (e.key === "Shift") {
                this.shiftHeld = false;
            }
        });
        window.addEventListener("blur", () => {
            this.shiftHeld = false;
        });

        this.#addTouchGestures();

        this.canvas.addEventListener("mouseup", (e) => {
            if (e.button !== 0) {
                return;
            }

            if (this.selecting) {
                this.mouseX = this.#toGraphX(e);
                this.shiftHeld = e.shiftKey;
                this.selectionEndX = this.getCursorX();
                this.selecting = false;
                this.render();
            }
        });
    }

    // Touch (iPad): drag left/right to pan, pinch to zoom. The mouse keeps its selection behavior.
    #addTouchGestures() {
        const touches = new Map();      // pointerId -> { x, y } in graph area coordinates

        const pinchState = () => {
            const [a, b] = [...touches.values()];
            return { centerX: (a.x + b.x) / 2, distance: Math.hypot(a.x - b.x, a.y - b.y) };
        };

        this.canvas.addEventListener("pointerdown", (e) => {
            if (e.pointerType !== "touch") {
                return;
            }
            this.canvas.setPointerCapture(e.pointerId);
            touches.set(e.pointerId, { x: this.#toGraphX(e), y: this.#toGraphY(e) });
        });

        this.canvas.addEventListener("pointermove", (e) => {
            const previous = touches.get(e.pointerId);
            if (!previous) {
                return;
            }

            if (touches.size === 1) {
                const x = this.#toGraphX(e);
                this.panByPx(x - previous.x);
                touches.set(e.pointerId, { x, y: this.#toGraphY(e) });
            }
            else if (touches.size === 2) {
                const before = pinchState();
                touches.set(e.pointerId, { x: this.#toGraphX(e), y: this.#toGraphY(e) });
                const after = pinchState();

                if (after.distance > 0) {
                    this.zoomAt(before.distance / after.distance, before.centerX);
                }
                this.panByPx(after.centerX - before.centerX);
            }
        });

        const endTouch = (e) => {
            touches.delete(e.pointerId);
        };
        this.canvas.addEventListener("pointerup", endTouch);
        this.canvas.addEventListener("pointercancel", endTouch);
    }

    // mouse position in graph area coordinates, (0, 0) is the top-left of the graph area
    #toGraphX(e) {
        return e.clientX - this.canvas.getBoundingClientRect().left - this.marginPx;
    }

    #toGraphY(e) {
        return e.clientY - this.canvas.getBoundingClientRect().top - this.marginPx;
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

    // The grid divides the area from zero to the right edge into 20 segments.
    // The major line aligns with the zero point.
    drawGrid(ctx, graphWidthUs, graphWidthPx, graphHeightPx, zeroShiftUs, stepUs) {
        ctx.save();
        ctx.lineWidth = 1;

        const drawVerticalLine = (x, index) => {
            const isMajorLine = index % 2 === 0;

            ctx.strokeStyle = isMajorLine
                ? "rgba(52, 229, 189, 0.26)"
                : "rgba(142, 161, 189, 0.18)";

            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, graphHeightPx);
            ctx.stroke();
        };

        const zeroX = zeroShiftUs / graphWidthUs * graphWidthPx;
        const stepPx = stepUs / graphWidthUs * graphWidthPx;

        // Only the visible lines, the zero point itself may be outside the view when panned.
        const firstIndex = Math.ceil(-zeroX / stepPx);
        const lastIndex = Math.floor((graphWidthPx - zeroX) / stepPx);
        for (let index = firstIndex; index <= lastIndex; ++index) {
            drawVerticalLine(zeroX + index * stepPx, Math.abs(index));
        }

        const renderAdjustment = 0.5;
        for (let y = 0; y <= graphHeightPx; y += 20) {
            ctx.strokeStyle = "rgba(142, 161, 189, 0.08)";
            ctx.beginPath();
            ctx.moveTo(0, y + renderAdjustment);
            ctx.lineTo(graphWidthPx, y + renderAdjustment);
            ctx.stroke();
        }

        ctx.restore();
    }

    // Background and border of the graph area, the margin around it stays transparent.
    drawGraphArea(ctx) {
        ctx.save();
        ctx.fillStyle = "#050a11";
        ctx.fillRect(0, 0, this.graphWidthPx, this.graphHeightPx);
        ctx.strokeStyle = "rgba(52, 229, 189, 0.65)";
        ctx.lineWidth = 1;
        ctx.strokeRect(-0.5, -0.5, this.graphWidthPx + 1, this.graphHeightPx + 1);
        ctx.restore();
    }

    // Triangles in the margin above and below the graph area, pointing at the zero point.
    drawZeroMarkers(ctx) {
        if (this.graphWidthUs <= 0) {
            return;
        }

        const zeroX = this.zeroShiftUs / this.graphWidthUs * this.graphWidthPx;
        if (zeroX < 0 || zeroX > this.graphWidthPx) {
            return;     // panned out of view
        }

        const size = 6;     // height of the triangle, fits in the margin
        const gap = 1;      // space between the triangle tip and the graph area

        ctx.save();
        ctx.fillStyle = "white";

        // Top marker
        ctx.beginPath();
        ctx.moveTo(zeroX - 5, -gap - size);
        ctx.lineTo(zeroX + 5, -gap - size);
        ctx.lineTo(zeroX, -gap);
        ctx.closePath();
        ctx.fill();

        // Bottom marker
        ctx.beginPath();
        ctx.moveTo(zeroX - 5, this.graphHeightPx + gap + size);
        ctx.lineTo(zeroX + 5, this.graphHeightPx + gap + size);
        ctx.lineTo(zeroX, this.graphHeightPx + gap);
        ctx.closePath();
        ctx.fill();

        ctx.restore();
    }

    // The cursor follows the mouse, with shift held it snaps to the nearest visible
    // begin or end of the event under the mouse.
    getSnapX() {
        if (!this.shiftHeld || !this.hoveredBar) {
            return null;
        }

        const edges = [this.hoveredBar.x1, this.hoveredBar.x2]
            .filter(x => x >= 0 && x <= this.graphWidthPx);
        if (edges.length === 0) {
            return null;
        }

        return edges.reduce((nearest, x) =>
            Math.abs(x - this.mouseX) < Math.abs(nearest - this.mouseX) ? x : nearest);
    }

    getCursorX() {
        return this.getSnapX() ?? this.mouseX;
    }

    drawCursor(ctx) {
        if (!this.mouseInside) {
            return;
        }

        const snapped = this.getSnapX() !== null;
        const x = Math.round(this.getCursorX()) + 0.5;

        ctx.save();

        ctx.strokeStyle = snapped ? "#00ff88" : "rgba(255, 255, 255, 0.7)";
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
        this.triggerSource.setTriggerWord(triggerWord);
    }

    getTriggerWord() {
        return this.triggerSource.getTriggerWord();
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
        this.triggerSource.setPreTriggerUs(milliseconds * 1000);
    }

    getPreTriggerMs() {
        return this.triggerSource.getPreTriggerUs() / 1000;
    }

    autoSet() {
        const data = this.collector.data();
        const openEvents = new Map();
        let longestEventUs = 0;

        for (const event of data) {
            if (event.type === EventType.OPEN) {
                openEvents.set(event.name, event);
            } else if (event.type === EventType.CLOSE) {
                const openEvent = openEvents.get(event.name);
                if (!openEvent) {
                    continue;
                }

                longestEventUs = Math.max(
                    longestEventUs,
                    event.timestamp - openEvent.timestamp
                );

                openEvents.delete(event.name);
            }
        }

        if (longestEventUs > 0) {
            this.setgraphWidthMs(roundUpNice(longestEventUs) * 1.2 / 1000);
            this.onStatusChanged?.();
        }
    }

    clear() {
        this.triggerSource.clear();
        this.render();
    }

    auto() {
        this.triggerSource.auto();
    }

    // Running means the graph follows incoming events, it is paused while panning/zooming
    // or after a single trigger stopped the trigger source.
    isRunning() {
        return !this.manualView && this.triggerSource.isRunning();
    }

    toggleRunning() {
        if (this.isRunning()) {
            this.#enterManualView();
        }
        else {
            this.resume();
        }
    }

    single() {
        this.manualView = null;
        this.triggerSource.single();
        this.onStatusChanged?.();
    }

    // Normal grid: 20 segments from the zero point to the right edge.
    getGridStepUs() {
        const minorGridLineCount = 20;
        return (this.graphWidthUs - this.zeroShiftUs) / minorGridLineCount;
    }

    // While zooming, the step doubles or halves so there are always roughly 20 lines,
    // and every line still sits at a multiple of the original step from the zero point.
    getManualGridStepUs() {
        const view = this.manualView;
        const targetLineCount = 20;
        const exponent = Math.round(Math.log2(view.widthUs / (targetLineCount * view.baseStepUs)));
        return view.baseStepUs * Math.pow(2, exponent);
    }

    // Freeze the current view on a snapshot of the data, so it can be panned and zoomed.
    #enterManualView() {
        if (this.manualView || this.graphWidthUs <= 0) {
            return;
        }

        this.manualView = {
            data: (this.triggerSource.getAllData() ?? []).map(event => ({ ...event })),
            startUs: this.startPointUs,
            widthUs: this.graphWidthUs,
            zeroPointUs: this.startPointUs + this.zeroShiftUs,
            nowUs: this.collector.estimatedNowUs(),
            baseStepUs: this.getGridStepUs()
        };
        this.onStatusChanged?.();
    }

    // Pan by a fraction of the visible width, negative is to the left.
    pan(fraction) {
        this.#enterManualView();
        if (this.manualView) {
            this.manualView.startUs += fraction * this.manualView.widthUs;
        }
    }

    // Move the content by 'dx' pixels, positive moves it to the right (shows earlier events).
    panByPx(dx) {
        if (this.graphWidthPx > 0) {
            this.pan(-dx / this.graphWidthPx);
        }
    }

    // factor < 1 zooms in, factor > 1 zooms out. The time under the mouse cursor stays
    // in place, if the mouse is outside the graph its last position is used.
    zoom(factor) {
        this.zoomAt(factor, this.mouseX);
    }

    // Zoom keeping the time at graph x-position 'anchorX' in place.
    zoomAt(factor, anchorX) {
        this.#enterManualView();
        const view = this.manualView;
        if (!view) {
            return;
        }

        const minWidthUs = 10;
        const maxWidthUs = 60 * 1e6;    // the collector keeps the last minute
        const newWidthUs = Math.min(maxWidthUs, Math.max(minWidthUs, view.widthUs * factor));

        const anchor = this.graphWidthPx > 0 ? Math.min(1, Math.max(0, anchorX / this.graphWidthPx)) : 0.5;
        const anchorUs = view.startUs + anchor * view.widthUs;
        view.startUs = anchorUs - anchor * newWidthUs;
        view.widthUs = newWidthUs;
    }

    // Leave the manual view and continue showing incoming events.
    resume() {
        this.manualView = null;
        if (!this.triggerSource.isRunning()) {
            this.triggerSource.toggleRunning();     // notifies onStatusChanged
        }
        else {
            this.onStatusChanged?.();
        }
    }

    render() {
        const ctx = this.canvas.getContext("2d");
        if (!ctx) return

        const dpr = window.devicePixelRatio || 1; // dpr == 1.25 if your browser zoom is 125%
        const canvasWidthPx = this.canvas.width / dpr;
        const canvasHeightPx = this.canvas.height / dpr;
        ctx.clearRect(0, 0, canvasWidthPx, canvasHeightPx);

        this.graphWidthPx = Math.max(0, canvasWidthPx - 2 * this.marginPx);
        this.graphHeightPx = Math.max(0, canvasHeightPx - 2 * this.marginPx);

        // everything is drawn in graph area coordinates
        ctx.save();
        ctx.translate(this.marginPx, this.marginPx);
        this.drawGraphArea(ctx);

        // the graph itself is clipped to the graph area
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, this.graphWidthPx, this.graphHeightPx);
        ctx.clip();
        this.renderGraph(ctx);
        if (this.selecting) {
            this.selectionEndX = this.getCursorX();
        }
        this.drawSelection(ctx);
        this.drawCursor(ctx);
        ctx.restore();

        this.drawZeroMarkers(ctx);
        ctx.restore();
    }

    renderGraph(ctx) {
        // We always draw the grid and pre-trigger cursor
        this.hoveredBar = null;

        const graphWidthMs = this.getGraphWidthMs();
        const preTriggerMs = this.getPreTriggerMs();

        let data;
        let estimatedNowUs;
        let zeroPointUs;

        if (this.manualView) {
            const view = this.manualView;
            this.startPointUs = view.startUs;
            this.graphWidthUs = view.widthUs;
            this.zeroShiftUs = view.zeroPointUs - view.startUs;
            this.drawGrid(ctx, this.graphWidthUs, this.graphWidthPx, this.graphHeightPx, this.zeroShiftUs, this.getManualGridStepUs());

            data = view.data;
            estimatedNowUs = view.nowUs;
            zeroPointUs = view.zeroPointUs;
        }
        else {
            // preTriggerMs < 0 will add to the width, while >= 0 will not affect the width
            const extraWidth = Math.max(preTriggerMs * -1, 0);
            this.zeroShiftUs = extraWidth * 1e3; // how far is the zero-point from the beginning of display in microseconds
            this.graphWidthUs = ((graphWidthMs + extraWidth) * 1e3);
            this.drawGrid(ctx, this.graphWidthUs, this.graphWidthPx, this.graphHeightPx, this.zeroShiftUs, this.getGridStepUs());

            const freeStartPointUs = this.collector.getLastTimepointUs() - this.graphWidthUs;
            this.startPointUs = this.triggerSource.updateStartPoint(freeStartPointUs);

            data = this.triggerSource.getGraphData();
            estimatedNowUs = this.collector.estimatedNowUs();
            zeroPointUs = this.startPointUs + this.zeroShiftUs;
        }

        if (data.length === 0) {
            return;
        }

        const graphEndUs = this.startPointUs + this.graphWidthUs;
        const endPointUs = Math.min(estimatedNowUs, graphEndUs);

        const bars = new BarStack(
            ctx,
            this.mouseX,
            this.mouseY,
            this.graphWidthPx / this.graphWidthUs,
            this.startPointUs,
            endPointUs,
            zeroPointUs
        );
        bars.areaWidthPx = this.graphWidthPx;
        bars.areaHeightPx = this.graphHeightPx;

        // Pair open/close events over all data, so events that started before the view are
        // still found. Only events that overlap the view are added to the bars, so threads and
        // lanes are not taken up by events that are not visible.
        const isVisible = (startUs, endUs) => endUs >= this.startPointUs && startUs <= graphEndUs;
        const groups = new Map();   // groupId -> { openMap, lastEndTime }

        for (let i = 0; i < data.length; ++i) {
            const event = data[i];
            let group = groups.get(event.groupId);
            if (!group) {
                group = { openMap: new Map(), lastEndTime: 0 };
                groups.set(event.groupId, group);
            }
            if (event.timestamp > group.lastEndTime) {
                group.lastEndTime = event.timestamp;
            }

            if (event.type === EventType.OPEN) {
                group.openMap.set(event.name, event);
            }

            if (event.type === EventType.CLOSE) {
                const start_event = group.openMap.get(event.name);
                if (!start_event) continue;
                group.openMap.delete(event.name);

                if (isVisible(start_event.timestamp, event.timestamp)) {
                    const closedEvent = {
                        ...start_event,   // take a copy
                        end_time: event.timestamp,          // closedEvent now has timestamp + end_time
                        type: EventType.CLOSE
                    };
                    bars.getLine(event.groupId).closedEvents.push(closedEvent);
                }
            }

            if (event.type === EventType.DURATION && isVisible(event.timestamp, event.end_time ?? event.timestamp)) {
                bars.getLine(event.groupId).closedEvents.push(event);
            }
        }

        // events that are still open extend to the end of the view
        for (const [groupId, group] of groups) {
            const openEvents = [...group.openMap.values()].filter(event => event.timestamp <= graphEndUs);
            if (openEvents.length === 0 && !bars.lines.has(groupId)) {
                continue;
            }

            const line = bars.getLine(groupId);
            line.lastEndTime = group.lastEndTime;
            for (const event of openEvents) {
                line.openMap.set(event.name, event);
                if (event.timestamp < bars.beginTime) {
                    bars.beginTime = event.timestamp;
                }
            }
        }

        bars.drawEvents();
        this.hoveredBar = bars.hover;
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
