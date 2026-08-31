// A tiny FIFO turn scheduler. It exists so ChatView can keep its input prompt
// live during a planner turn: submissions made mid-turn are queued and drained
// one at a time (turns must never run concurrently). Kept framework-agnostic so
// the ordering/re-entrancy guarantees can be unit-tested without a renderer.

export interface TurnQueue {
  /** Enqueue a message and ensure the drain loop is running (FIFO). */
  submit(text: string): void;
  /** Messages waiting to start, oldest first. Excludes the in-flight turn. */
  pending(): string[];
}

export interface TurnQueueOptions {
  /** Runs a single turn to completion. Never invoked concurrently with itself. */
  runTurn: (text: string) => Promise<void>;
  /** Notified with the pending list whenever it changes (for rendering). */
  onChange?: (pending: string[]) => void;
}

export function createTurnQueue({ runTurn, onChange }: TurnQueueOptions): TurnQueue {
  let queue: string[] = [];
  let running = false;

  const notify = () => onChange?.([...queue]);

  // The single drain loop. `running` guards against re-entrancy so that a
  // submission arriving mid-turn only appends to the queue — it never starts a
  // second concurrent loop. The loop keeps pulling until the queue is empty.
  async function drain(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0) {
        const text = queue[0]!;
        queue = queue.slice(1);
        notify();
        await runTurn(text);
      }
    } finally {
      running = false;
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
  };
}
