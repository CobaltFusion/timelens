// Display modes, a click on the indicator cycles through them.
const Mode = Object.freeze({
    DURATIONS: 0,   // one line per event name, length is the last duration
    SIGNATURE: 1    // a walk where every message type is a fixed direction
});

const modeTitles = [
    "Health indication: durations (click to switch)",
    "Health indication: message signature (click to switch)"
];

const anomalyColor = "#ff4d4d";

// Stable string hash (FNV-1a), so a message type always maps to the same direction.
function hashString(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; ++i) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

export class HealthIndication {
    constructor(parent) {
        this.mode = Mode.DURATIONS;
        this.historyLength = 60;
        this.lineWidth = 2;
        this.eventHistory = [];
        this.pendingEvents = new Map();
        this.drawFrame = null;          // pending requestAnimationFrame, see scheduleDraw()
        this.eventColors = new Map();

        // Signature mode state
        this.signatureLength = 200;       // number of messages in the shape
        this.signature = [];             // { name, angle, step, anomaly }
        this.messageStats = new Map();   // per message type: { lastTimestamp, mean, variance, count }
        this.lastTimestamp = undefined;
        this.messageCount = 0;
        this.warmupMessages = 1000;        // new message types are not flagged during warm-up
        this.anomalyThreshold = 4;       // in standard deviations of the log interval

        this.canvas = document.createElement("canvas");
        this.canvas.classList.add("health-indication");
        this.canvas.title = modeTitles[this.mode];
        this.canvas.addEventListener("click", () => {
            this.toggleMode();
        });

        parent.appendChild(this.canvas);

        this.ctx = this.canvas.getContext("2d");

        this.resize();
        this.resizeObserver = new ResizeObserver(() => {
            this.resize();
        });
        this.resizeObserver.observe(this.canvas);
    }

    toggleMode() {
        this.mode = this.mode === Mode.DURATIONS ? Mode.SIGNATURE : Mode.DURATIONS;
        this.canvas.title = modeTitles[this.mode];
        this.draw();
    }

    onIncomingEvent(event) {
        this.addSignatureMessage(event);

        const { name, timestamp } = event;
        const previous = this.pendingEvents.get(name);

        if (previous !== undefined) {
            const duration = timestamp - previous.timestamp;

            this.addEvent({
                name,
                start: previous.timestamp,
                duration
            });

            this.pendingEvents.delete(name);
        } else {
            this.pendingEvents.set(name, event);
        }

        this.scheduleDraw();
    }

    // Messages can arrive much faster than the screen refreshes, so draw at most once per frame.
    scheduleDraw() {
        if (this.drawFrame !== null) {
            return;
        }
        this.drawFrame = requestAnimationFrame(() => {
            this.drawFrame = null;
            this.draw();
        });
    }

    addEvent(event) {
        this.eventHistory.push(event);

        if (this.eventHistory.length > this.historyLength) {
            this.eventHistory.shift();
        }
    }

    // Every message type (name + open/close) gets a fixed direction, and the step
    // length is the log of the time since the previous message. A repeating sequence
    // of messages then always draws the same motif.
    addSignatureMessage(event) {
        const key = `${event.name}:${event.type}`;
        const timestamp = event.timestamp;

        const gapUs = this.lastTimestamp === undefined ? 0 : Math.max(0, timestamp - this.lastTimestamp);
        this.lastTimestamp = timestamp;
        ++this.messageCount;

        this.signature.push({
            name: event.name,
            angle: (hashString(key) % 360) * Math.PI / 180,
            step: 1 + Math.log10(1 + gapUs / 100),
            anomaly: this.updateMessageStats(key, timestamp)
        });

        if (this.signature.length > this.signatureLength) {
            this.signature.shift();
        }
    }

    // Tracks the interval between messages of the same type and returns true if this
    // message is unusual: a new type after warm-up, or an interval far from the usual one.
    updateMessageStats(key, timestamp) {
        const stats = this.messageStats.get(key);

        if (stats === undefined) {
            this.messageStats.set(key, { lastTimestamp: timestamp, mean: 0, variance: 0, count: 0 });
            return this.messageCount > this.warmupMessages;
        }

        const interval = Math.log10(1 + Math.max(0, timestamp - stats.lastTimestamp));
        stats.lastTimestamp = timestamp;

        let anomaly = false;
        if (stats.count >= 8) {
            // the floor keeps tiny jitter on very regular messages from being flagged
            const deviation = Math.sqrt(stats.variance) + 0.07;
            anomaly = Math.abs(interval - stats.mean) / deviation > this.anomalyThreshold;
        }

        // exponentially weighted mean and variance
        const alpha = stats.count === 0 ? 1 : Math.max(0.05, 1 / (stats.count + 1));
        const difference = interval - stats.mean;
        stats.mean += alpha * difference;
        stats.variance = (1 - alpha) * (stats.variance + alpha * difference * difference);
        ++stats.count;

        return anomaly;
    }

    getColor(name) {
        let color = this.eventColors.get(name);

        if (color !== undefined) {
            return color;
        }

        const colors = [
            "#34e5bd",
            "#60a5fa",
            "#a78bfa",
            "#f59e0b",
            "#f472b6",
            "#22d3ee",
            "#a3e635",
            "#fb7185"
        ];

        color = colors[this.eventColors.size % colors.length];
        this.eventColors.set(name, color);

        return color;
    }

    draw() {
        const rect = this.canvas.getBoundingClientRect();
        const width = rect.width;
        const height = rect.height;

        this.ctx.clearRect(0, 0, width, height);

        if (this.mode === Mode.SIGNATURE) {
            this.drawSignature(width, height);
        } else {
            this.drawDurations(width, height);
        }
    }

    drawSignature(width, height) {
        if (this.signature.length < 2) {
            return;
        }

        // walk the path
        const points = [{ x: 0, y: 0 }];
        let x = 0;
        let y = 0;
        for (const message of this.signature) {
            x += Math.cos(message.angle) * message.step;
            y += Math.sin(message.angle) * message.step;
            points.push({ x, y });
        }

        // Rotate so the overall drift runs left to right; a periodic pattern then
        // becomes a strip of repeating motifs. If there is hardly any drift the
        // pattern closes on itself and is left unrotated.
        let bounds = this.getBounds(points);
        const extent = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
        const rotation = Math.hypot(x, y) > extent * 0.25 ? -Math.atan2(y, x) : 0;
        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);
        for (const p of points) {
            const rx = p.x * cos - p.y * sin;
            p.y = p.x * sin + p.y * cos;
            p.x = rx;
        }
        bounds = this.getBounds(points);

        // fit into the canvas, keeping the aspect ratio so shapes stay comparable
        const padding = 4;
        const spanX = Math.max(bounds.maxX - bounds.minX, 1e-6);
        const spanY = Math.max(bounds.maxY - bounds.minY, 1e-6);
        const scale = Math.min((width - 2 * padding) / spanX, (height - 2 * padding) / spanY);
        const offsetX = (width - spanX * scale) / 2 - bounds.minX * scale;
        const offsetY = (height - spanY * scale) / 2 - bounds.minY * scale;
        for (const p of points) {
            p.x = p.x * scale + offsetX;
            p.y = p.y * scale + offsetY;
        }

        const ctx = this.ctx;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        // segments, older ones fade out
        const count = this.signature.length;
        for (let i = 0; i < count; ++i) {
            const message = this.signature[i];
            ctx.globalAlpha = 0.25 + 0.75 * (i + 1) / count;
            ctx.beginPath();
            ctx.moveTo(points[i].x, points[i].y);
            ctx.lineTo(points[i + 1].x, points[i + 1].y);
            ctx.strokeStyle = message.anomaly ? anomalyColor : this.getColor(message.name);
            ctx.lineWidth = message.anomaly ? 2 : 1.25;
            ctx.stroke();
        }
        ctx.globalAlpha = 1;

        // mark anomalies so they stand out even when the segment is short
        ctx.fillStyle = anomalyColor;
        for (let i = 0; i < count; ++i) {
            if (this.signature[i].anomaly) {
                ctx.beginPath();
                ctx.arc(points[i + 1].x, points[i + 1].y, 2.5, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // current position
        const head = points[points.length - 1];
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(head.x, head.y, 1.5, 0, Math.PI * 2);
        ctx.fill();
    }

    getBounds(points) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const p of points) {
            minX = Math.min(minX, p.x);
            maxX = Math.max(maxX, p.x);
            minY = Math.min(minY, p.y);
            maxY = Math.max(maxY, p.y);
        }
        return { minX, maxX, minY, maxY };
    }

    drawDurations(width, height) {
        if (this.eventHistory.length === 0) {
            return;
        }

        const names = [...new Set(
            this.eventHistory.map(event => event.name)
        )];

        const laneStep = Math.max(
            1,
            (height - this.lineWidth) /
            Math.max(1, names.length - 1)
        );

        const maxDuration = Math.max(
            ...this.eventHistory.map(event => event.duration),
            1
        );

        for (const event of this.eventHistory) {
            const lane = names.indexOf(event.name);

            if (lane < 0) {
                continue;
            }

            const y =
                lane * laneStep +
                this.lineWidth / 2;

            const lineLength =
                event.duration / maxDuration * width;

            const color = this.getColor(event.name);

            this.ctx.beginPath();
            this.ctx.moveTo(0, y);
            this.ctx.lineTo(
                Math.max(this.lineWidth, lineLength),
                y
            );

            this.ctx.strokeStyle = color;
            this.ctx.lineWidth = this.lineWidth;
            this.ctx.lineCap = "round";
            this.ctx.stroke();
        }

    }

    resize() {
        const rect = this.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;

        this.canvas.width =
            Math.max(1, Math.round(rect.width * dpr));
        this.canvas.height =
            Math.max(1, Math.round(rect.height * dpr));

        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        this.draw();
    }

    destroy() {
        cancelAnimationFrame(this.drawFrame);
        this.resizeObserver.disconnect();
        this.canvas.remove();
    }
}
