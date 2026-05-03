const EventType = {
    OPEN: "open",           // only has a valid begin_time
    CLOSE: "close",         // only has a valid end_time
    DURATION: "duration",   // both begin_time + end_time are valid
    VALUE: "value"          // has a valid begin_time + value
};

function makeEvent(name, type, begin_time, end_time, value = 0) {
    return { name, type, begin_time, end_time, value }
}

class Collector {
    constructor() {
        this.width = 200;
        this.incoming = []; // this an array of structs, if GC becomes a problem, we should turn this into a struct of arrays for zero-reallocation

        this.incoming.push(makeEvent("cycle", EventType.OPEN, 0));
        this.incoming.push(makeEvent("capture_image", EventType.DURATION, 10, 230));

        this.incoming.push(makeEvent("process_image", EventType.OPEN, 231, 0));
        this.incoming.push(makeEvent("set_outputs", EventType.DURATION, 310, 400));
        this.incoming.push(makeEvent("process_image", EventType.CLOSE, 0, 300)); // intentionally out-of-order
        //this.incoming.push(makeEvent("cycle", EventType.CLOSE, 0, 500)); // intentionally omitted

        const host = "localhost";
        const ws = new WebSocket(`ws://${host}/ws`);
        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            const { name, type, ts, te, value } = data;

            const eventType = EventType[type];

            if (!eventType) {
                console.warn(`Unknown event type: ${type}, name: ${name}`);
                return;
            }
            this.incoming.push(makeEvent(name, EventType[type], ts, te, value));
        }
    }

    clear() {
        // this clears the elements, incoming[0]  // undefined
        // but does not release the underlying storage, so its efficient and GC friendly
        this.incoming.length = 0;
    }

    data() {
        return this.incoming; // returns a reference, not a copy
    }

    stop() {
        // stop receiving more data.
    }

    start() {
        // re-start receiving data
    }
}
