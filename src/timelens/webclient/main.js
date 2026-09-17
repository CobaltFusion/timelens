// not using modules yet
// import { Graph } from "./scope_controls.js";

// [] array
// {} object
// [{},{}] // array of two objects
// console.log("Test");

class Main {
    constructor() {
        this.widgets = new Set();
        this.collector = new Collector();
        this.connectionStatus = null;
    }

    init() {
        this.addControls();
        this.addScope();

        this.collector.onConnectionLost = () => {
            console.error("Collector connection was closed");
            this.setConnectionStatus(false)
        };

        window.onresize = () => {
            this.resizeObjects();
        };

        window.onload = () => {
            this.renderObjects();
        };
    }

    resizeObjects() {
        for (const widget of this.widgets) {
            widget.resize();
        }
    }

    renderObjects() {
        const render = () => {
            for (const widget of this.widgets) {
                widget.component.render();
            }

            requestAnimationFrame(render);
        };

        render();
    }

    setConnectionStatus(connected) {
        this.connectionStatus.textContent = connected ? "Connected" : "Disconnected";
        this.connectionStatus.style.background = connected ? "var(--status-connected)" : "var(--status-disconnected)";
    }

    addControls() {
        const controls = document.getElementById("id_control_panel");

        const triggerWordLabel = document.createElement("label");
        triggerWordLabel.textContent = "Trigger word: ";
        triggerWordLabel.htmlFor = "id_trigger_word";

        const triggerWordInput = document.createElement("input");
        triggerWordInput.id = "id_trigger_word";
        triggerWordInput.type = "text";
        triggerWordInput.value = this.collector.getTriggerWord();
        triggerWordInput.addEventListener("input", () => {
            this.collector.setTriggerWord(triggerWordInput.value);
        });

        triggerWordLabel.appendChild(triggerWordInput);
        controls.appendChild(triggerWordLabel);

        const offsetLabel = document.createElement("span");
        offsetLabel.textContent = "Offset:";
        controls.appendChild(offsetLabel);

        new NumericControl({
            parent: controls,
            value: this.collector.getOffset(),
            step: 10,
            inputStep: 1,
            min: -Infinity,
            unit: "ms",
            onChange: (value) => this.collector.setOffset(value)
        });

        const gridScaleLabel = document.createElement("span");
        gridScaleLabel.textContent = "Graph width:";
        controls.appendChild(gridScaleLabel);

        new NumericControl({
            parent: controls,
            value: this.collector.getMillisecondsPerGraphWidth(),
            step: 10,
            inputStep: 1,
            min: 0.1,
            unit: "ms",
            onChange: (value) => {
                this.collector.setMillisecondsPerGraphWidth(value);
            }
        });

        const addButton = document.createElement("button");
        addButton.textContent = "Add Graph";
        addButton.addEventListener("click", () => this.addScope());
        controls.appendChild(addButton);

        const resetButton = document.createElement("button");
        resetButton.textContent = "Reset";
        resetButton.addEventListener("click", () => this.collector.reset());
        controls.appendChild(resetButton);

        const dummyButton = document.createElement("button");
        dummyButton.textContent = "Add dummy data";
        dummyButton.addEventListener("click", () => this.collector.dummy());
        controls.appendChild(dummyButton);

        const audioButton = document.createElement("button");

        const updateAudioButton = async () => {
            const audioEnabled = await this.collector.isAudioEnabled();
            audioButton.textContent =
                audioEnabled ? "Audio (On) " : "Audio (Muted)";
        };

        audioButton.addEventListener("click", async () => {
            await this.collector.toggleAudio();
            await updateAudioButton();
        });

        controls.appendChild(audioButton);
        updateAudioButton();

        const connectionStatus = document.createElement("button");
        connectionStatus.id = "id_connection_status";
        controls.appendChild(connectionStatus);
        this.connectionStatus = connectionStatus;
        this.setConnectionStatus(true);
    }

    addScope() {
        const graphPanel = document.getElementById("id_graph_panel");
        const graph = new Graph(this.collector);

        const widget = new ResizableContainer({
            parent: graphPanel,
            component: graph,
            onClose: () => {
                this.widgets.delete(widget);
            }
        });

        this.widgets.add(widget);
    }
}

const main = new Main();
main.init();
