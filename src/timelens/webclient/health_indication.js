export class HealthIndication {
    constructor(parent) {
        this.historyLength = 60;
        this.lineWidth = 2;
        this.eventHistory = [];
        this.pendingEvents = new Map();
        this.eventColors = new Map();

        this.canvas = document.createElement("canvas");
        this.canvas.classList.add("health-indication");
        this.canvas.title = "Health indication";

        parent.appendChild(this.canvas);

        this.ctx = this.canvas.getContext("2d");

        this.resize();
        this.resizeObserver = new ResizeObserver(() => {
            this.resize();
        });
        this.resizeObserver.observe(this.canvas);
    }

    onIncomingEvent(event) {
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

        this.draw();
    }

    addEvent(event) {
        this.eventHistory.push(event);

        if (this.eventHistory.length > this.historyLength) {
            this.eventHistory.shift();
        }
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
            this.ctx.shadowColor = color;
            this.ctx.shadowBlur = 3;
            this.ctx.stroke();
        }

        this.ctx.shadowBlur = 0;
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
        this.resizeObserver.disconnect();
        this.canvas.remove();
    }
}
