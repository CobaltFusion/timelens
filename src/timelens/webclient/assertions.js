const ASSERTIONS_ENABLED = true

export function assert(condition, messageFn) {
    if (!ASSERTIONS_ENABLED) return;

    if (!condition) {
        throw new Error(
            typeof messageFn === "function" ? messageFn() : messageFn
        );
    }
}
