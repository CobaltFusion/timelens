// not using modules yet
// import { Graph } from "./scope_controls.js";

// [] array
// {} object
// [{},{}] // array of two objects
// console.log("Test");

function containsIgnoreCase(text, search) {
    return text.toLowerCase().includes(search.toLowerCase());
}

class Main {
    constructor() {
        this.widgets = new Set();
        this.collector = new Collector();
        this.connectionStatus = null;
        this.audioAlerts = new AudioAlerts();
    }

    init() {
        this.addControls();
        this.addScope();

        this.collector.onConnectionLost = () => {
            console.error("Collector connection was closed");
            this.setConnectionStatus(false)
        };

        this.collector.onIncomingEvent = (event) => {

            // beeping
            if (event.type === EventType.OPEN) {
                if (containsIgnoreCase(event.name, "error")) {
                    console.log("Error beeping");
                    this.audioAlerts.beep(1300, 0, 0.03, "square");
                }
                if (containsIgnoreCase(event.name, "message")) {
                    console.log("Message beeping");
                    this.audioAlerts.beep(800, 0, 0.05);
                }
            }
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

        //setInterval(render, 500);
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

        const preTriggerLabel = document.createElement("span");
        preTriggerLabel.textContent = "PreTrigger:";
        controls.appendChild(preTriggerLabel);

        new NumericControl({
            parent: controls,
            value: this.collector.getPreTriggerMs(),
            step: 10,
            inputStep: 1,
            min: -Infinity,
            max: -0,
            unit: "ms",
            onChange: (value) => this.collector.setPreTrigger(value)
        });

        const graphWidthLabel = document.createElement("span");
        graphWidthLabel.textContent = "View:";
        controls.appendChild(graphWidthLabel);

        new NumericControl({
            parent: controls,
            value: this.collector.getGraphWidthMs(),
            step: 10,
            inputStep: 1,
            min: 0.001,
            unit: "ms",
            onChange: (value) => {
                this.collector.setgraphWidthMs(value);
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
        dummyButton.addEventListener("click", () => {
            this.collector.dummy();
            this.audioAlerts.beep(1300, 0.0, 0.05, "square");
        });
        controls.appendChild(dummyButton);

        const audioButton = document.createElement("button");

        const updateAudioButton = async () => {
            const audioEnabled = await this.audioAlerts.isAudioEnabled();
            audioButton.textContent =
                audioEnabled ? "Audio (On) " : "Audio (Muted)";
        };

        audioButton.addEventListener("click", async () => {
            await this.audioAlerts.toggleAudio();
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
