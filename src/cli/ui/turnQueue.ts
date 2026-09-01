// A tiny FIFO turn scheduler. It exists so ChatView can keep its input prompt
// live during a planner turn: submissions made mid-turn are queued and drained
// one at a time (turns must never run concurrently). Kept framework-agnostic so
// the ordering/re-entrancy guarantees can be unit-tested without a renderer.

export interface TurnQueue {
  /** Enqueue a message and ensure the drain loop is running (FIFO). */
  submit(text: string): void;
  /** Messages waiting to start, oldest first. Excludes the in-flight turn. */
  pending(): string[];
  /**
   * True while the drain loop is active (a turn is running or queued). Read
   * synchronously — unlike React state it can't be stale, so callers can decide
   * on the spot whether a just-submitted message will start immediately.
   */
  isRunning(): boolean;
}

export interface TurnQueueOptions {
  /** Runs a single turn to completion. Never invoked concurrently with itself. */
  runTurn: (text: string) => Promise<void>;
  /** Notified with the pending list whenever it changes (for rendering). */
  onChange?: (pending: string[]) => void;
  /**
   * Notified when the drain loop starts (true) and when it fully empties (false).
   * Unlike per-turn state, this stays true across back-to-back queued turns, so a
   * "processing" indicator driven off it never flickers off between them.
   */
  onRunning?: (running: boolean) => void;
}

export function createTurnQueue({ runTurn, onChange, onRunning }: TurnQueueOptions): TurnQueue {
  let queue: string[] = [];
  let running = false;

  const notify = () => onChange?.([...queue]);

  // The single drain loop. `running` guards against re-entrancy so that a
  // submission arriving mid-turn only appends to the queue — it never starts a
  // second concurrent loop. The loop keeps pulling until the queue is empty.
  async function drain(): Promise<void> {
    if (running) return;
    running = true;
    onRunning?.(true);
    try {
      while (queue.length > 0) {
        const text = queue[0]!;
        queue = queue.slice(1);
        notify();
        await runTurn(text);
      }
    } finally {
      running = false;
      onRunning?.(false);
    }
  }

  return {
    submit(text) {
      queue = [...queue, text];
      notify();
      void drain();
    },
    pending() {
      return [...queue];
    },
    isRunning() {
      return running;
    },
  };
}
