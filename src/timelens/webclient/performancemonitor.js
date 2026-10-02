export class PerformanceMonitor {
    constructor() {
        this.fps = 0;
        this.resizePerSecond = 0;
        this.websocketPerSecond = 0;
        this.eventLoopLag = 0;

        this.resizeCount = 0;
        this.websocketCount = 0;
        this.frameCount = 0;

        this.lastFrame = performance.now();
        this.lastSample = performance.now();

        this.element = document.createElement('pre');
        this.element.style.cssText = `
            position: fixed;
            top: 8px;
            right: 8px;
            z-index: 999999;
            margin: 0;
            padding: 8px;
            background: rgba(0, 0, 0, 0.8);
            color: white;
            font: 12px monospace;
            pointer-events: none;
            white-space: pre;
        `;

        if (new URLSearchParams(window.location.search).get("debug") === "1") {
            document.body.appendChild(this.element);
            this.start();
        }
    }

    countResize() {
        ++this.resizeCount;
    }

    countWebSocketMessage() {
        ++this.websocketCount;
    }

    start() {
        const frame = (now) => {
            ++this.frameCount;
            this.lastFrame = now;
            requestAnimationFrame(frame);
        };

        requestAnimationFrame(frame);

        setInterval(() => {
            const now = performance.now();
            const elapsed = (now - this.lastSample) / 1000;

            this.fps = this.frameCount / elapsed;
            this.resizePerSecond = this.resizeCount / elapsed;
            this.websocketPerSecond = this.websocketCount / elapsed;

            this.frameCount = 0;
            this.resizeCount = 0;
            this.websocketCount = 0;
            this.lastSample = now;

            this.updateDisplay();
        }, 1000);

        this.startEventLoopMonitor();
    }

    startEventLoopMonitor() {
        let expected = performance.now() + 100;

        const check = () => {
            const now = performance.now();

            this.eventLoopLag = Math.max(0, now - expected);

            expected = now + 100;
            setTimeout(check, 100);
        };

        setTimeout(check, 100);
    }

    updateDisplay() {
        this.element.textContent =
            `FPS:        ${this.fps.toFixed(1)}
Resize/s:   ${this.resizePerSecond.toFixed(1)}
WebSocket/s: ${this.websocketPerSecond.toFixed(1)}
Event lag:  ${this.eventLoopLag.toFixed(1)} ms`;
    }

    destroy() {
        this.element.remove();
    }
}
