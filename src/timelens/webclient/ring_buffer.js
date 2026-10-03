/**
 * A fixed capacity circular buffer. The storage is allocated once, pushing and dropping
 * items only moves indices, so nothing is shifted or re-allocated.
 * When the buffer is full, pushing overwrites the oldest item.
 */
export class RingBuffer {
    constructor(capacity) {
        if (!Number.isInteger(capacity) || capacity <= 0) {
            throw new RangeError("RingBuffer: capacity must be a positive integer");
        }
        this.capacity = capacity;
        this.items = new Array(capacity).fill(undefined);   // filled, so the array is not sparse
        this.head = 0;      // index of the oldest item
        this.length = 0;
        this.pushCount = 0; // every pushed item gets sequence number 'pushCount', it is never reset
    }

    // sequence number of the oldest item, the newest item has 'pushCount - 1'
    get firstSequence() {
        return this.pushCount - this.length;
    }

    #index(i) {
        return (this.head + i) % this.capacity;
    }

    push(item) {
        ++this.pushCount;
        if (this.length === this.capacity) {
            this.items[this.head] = item;       // overwrite the oldest
            this.head = this.#index(1);
            return;
        }
        this.items[this.#index(this.length)] = item;
        ++this.length;
    }

    // i = 0 is the oldest item
    at(i) {
        if (i < 0 || i >= this.length) {
            return undefined;
        }
        return this.items[this.#index(i)];
    }

    // Drops items from the oldest side for as long as 'predicate' returns true.
    dropWhile(predicate) {
        while (this.length > 0 && predicate(this.items[this.head])) {
            this.items[this.head] = undefined;  // release the reference
            this.head = this.#index(1);
            --this.length;
        }
    }

    clear() {
        for (let i = 0; i < this.length; ++i) {
            this.items[this.#index(i)] = undefined;
        }
        this.head = 0;
        this.length = 0;
    }

    // returns a new array with the matching items, oldest first
    filter(predicate) {
        const result = [];
        for (let i = 0; i < this.length; ++i) {
            const item = this.items[this.#index(i)];
            if (predicate(item)) {
                result.push(item);
            }
        }
        return result;
    }

    // A read-only view on the items from sequence number 'sequence' onwards, without copying.
    // It is meant to be used right away, pushing or dropping items shifts what it shows.
    viewFrom(sequence) {
        return new RingBufferView(this, Math.max(0, sequence - this.firstSequence));
    }

    *[Symbol.iterator]() {
        for (let i = 0; i < this.length; ++i) {
            yield this.items[this.#index(i)];
        }
    }
}

export class RingBufferView {
    constructor(ring, offset) {
        this.ring = ring;
        this.offset = offset;
    }

    get length() {
        return Math.max(0, this.ring.length - this.offset);
    }

    // sequence number of the item at(0)
    get firstSequence() {
        return this.ring.firstSequence + this.offset;
    }

    at(i) {
        return i < 0 ? undefined : this.ring.at(this.offset + i);
    }
}
