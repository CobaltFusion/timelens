// not using modules yet
//import { Graph } from "./scope_controls.js";

// [] array
// {} object
// [{},{}] // array of two objects
// console.log("Test");

function resizeObjects() {
    for (const widget of widgets) {
        widget.resize();
    }
}

function renderObjects() {

    function render() {
        for (const widget of widgets) {
            widget.component.render();
        }
        requestAnimationFrame(render);
    }
    render();
}

const widgets = new Set();
const collector = new Collector();

function addControls() {
    const controls = document.getElementById("id_control_panel");

    const addButton = document.createElement("button");
    addButton.textContent = "Add Graph";
    addButton.addEventListener("click", () => addScope(collector));
    controls.appendChild(addButton);


    const stopButton = document.createElement("button");
    stopButton.textContent = "Stop";
    stopButton.addEventListener("click", () => collector.stop());
    controls.appendChild(stopButton);

    const startButton = document.createElement("button");
    startButton.textContent = "Start";
    startButton.addEventListener("click", () => collector.start());
    controls.appendChild(startButton);

    const resetButton = document.createElement("button");
    resetButton.textContent = "Reset";
    resetButton.addEventListener("click", () => collector.reset());
    controls.appendChild(resetButton);

    const dummyButton = document.createElement("button");
    dummyButton.textContent = "Add dummy data";
    dummyButton.addEventListener("click", () => collector.dummy());
    controls.appendChild(dummyButton);

    async function updateAudioButton() {
        const state = await collector.audioState();
        audioButton.textContent = (state === "running") ? "Audio (On) " : "Audio (Muted)";
    }

    const audioButton = document.createElement("button");
    audioButton.addEventListener("click", async () => {
        await collector.toggleAudio();
        await updateAudioButton();
    });

    controls.appendChild(audioButton);
    updateAudioButton();
}

function addScope(collector) {
    const graph_panel = document.getElementById("id_graph_panel");
    const graph = new Graph(collector);
    const widget = new Widget({
        parent: graph_panel,
        component: graph,
        onClose: () => {
            widgets.delete(widget);
        }
    });
    widgets.add(widget)
}

function init() {
    addControls();
    addScope(collector);

    window.onresize = () => {
        resizeObjects();
    };
}

init();

window.onload = () => renderObjects();
