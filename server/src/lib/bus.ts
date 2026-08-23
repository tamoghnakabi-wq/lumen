/**
 * Thin indirection so route modules can push realtime events without importing
 * the socket layer (which imports routes' helpers in turn).
 */
type Emitter = (userId: string, event: string, payload: unknown) => void;

let emitter: Emitter = () => {};

export function setEmitter(fn: Emitter) {
  emitter = fn;
}

export function emitToUser(userId: string, event: string, payload: unknown) {
  emitter(userId, event, payload);
}

/**
 * Ends any live call between two people. Registered by the realtime layer;
 * a no-op before sockets are up, or in tests that never start them. Routes call
 * this rather than importing the socket server, same reason as the emitter.
 */
type CallBreaker = (userId: string, otherId: string, reason: string) => void;

let callBreaker: CallBreaker = () => {};

export function setCallBreaker(fn: CallBreaker) {
  callBreaker = fn;
}

export function dropCallBetween(userId: string, otherId: string, reason: string) {
  callBreaker(userId, otherId, reason);
}
