export class TrafficIndication {
    constructor(parent) {
        this.sampleIntervalMs = 100;
        this.eventsFor100Percent = 10;
        this.silenceDecayMs = 1000;
        this.historyLength = 60;

        this.eventCount = 0;
        this.level = 0;
        this.lastSampleTime = performance.now();
        this.lastEventTime = 0;
        this.history = [];

        this.canvas = document.createElement("canvas");
        this.canvas.classList.add("traffic-indication");
        this.canvas.title = "Incoming traffic";

        parent.appendChild(this.canvas);

        this.ctx = this.canvas.getContext("2d");

        this.resize();

        this.timer = setInterval(() => {
            this.sample();
        }, this.sampleIntervalMs);
    }

    onIncomingEvent() {
        ++this.eventCount;
        this.lastEventTime = performance.now();
    }

    sample() {
        const now = performance.now();
        const elapsedMs = now - this.lastSampleTime;
        this.lastSampleTime = now;

        const events = this.eventCount;
        this.eventCount = 0;

        const rawLevel =
            events / this.eventsFor100Percent;

        const targetLevel = Math.min(rawLevel, 1);

        if (events > 0) {
            // Smooth incoming traffic.
            this.level += (targetLevel - this.level) * 0.5;
        } else {
            // Decay towards zero when traffic stops.
            const decay =
                Math.exp(-elapsedMs / this.silenceDecayMs);

            this.level *= decay;
        }

        this.history.push(this.level);

        if (this.history.length > this.historyLength) {
            this.history.shift();
        }

        this.draw();
    }

    draw() {
        const rect = this.canvas.getBoundingClientRect();
        const width = rect.width;
        const height = rect.height;

        this.ctx.clearRect(0, 0, width, height);

        if (this.history.length < 2) {
            return;
        }

        this.ctx.beginPath();

        for (let i = 0; i < this.history.length; ++i) {
            const x =
                i * width / (this.historyLength - 1);

            const value = Math.min(1, this.history[i]);
            const y = height - value * height;

            if (i === 0) {
                this.ctx.moveTo(x, y);
            } else {
                this.ctx.lineTo(x, y);
            }
        }

        this.ctx.strokeStyle = getComputedStyle(this.canvas).color;
        this.ctx.lineWidth = 1.5;
        this.ctx.stroke();
    }

    resize() {
        const rect = this.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;

        this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
        this.canvas.height = Math.max(1, Math.round(rect.height * dpr));

        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        this.draw();
    }

    destroy() {
        clearInterval(this.timer);
        this.canvas.remove();
    }
}
