export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  | "auth-required";

export type ConnectionEvent =
  | { type: "connect" }
  | { type: "connected" }
  | { type: "disconnect" }
  | { type: "error"; message: string }
  | { type: "reconnecting"; attempt: number }
  | { type: "auth-expired" };

type Listener = (state: ConnectionState, event: ConnectionEvent) => void;

export class ConnectionStateManager {
  private state: ConnectionState = "disconnected";
  private listeners: Listener[] = [];

  getState(): ConnectionState {
    return this.state;
  }

  transition(event: ConnectionEvent): void {
    const prev = this.state;
    switch (event.type) {
      case "connect":
        this.state = "connecting";
        break;
      case "connected":
        this.state = "connected";
        break;
      case "disconnect":
        this.state = "disconnected";
        break;
      case "error":
        this.state = "error";
        break;
      case "reconnecting":
        this.state = "reconnecting";
        break;
      case "auth-expired":
        this.state = "auth-required";
        break;
    }
    if (this.state !== prev) {
      for (const l of this.listeners) l(this.state, event);
    }
  }

  onChange(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }
}
