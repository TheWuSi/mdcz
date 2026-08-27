import { describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "./executor";

const createExecutor = (runItem: (item: number) => Promise<void>, concurrency = 1) =>
  new TaskExecutor<number, void>({
    concurrency,
    runItem: async (item) => await runItem(item),
    applyResult: async () => undefined,
  });

describe("TaskExecutor stop", () => {
  it("honors a stop that arrived before the run started", async () => {
    const runItem = vi.fn(async () => undefined);
    const executor = createExecutor(runItem);

    // What a service shutdown looks like when it reaches the executor between registration and
    // `execute()`. Dropping it here let the whole batch run to completion.
    executor.stop();
    const summary = await executor.execute([1, 2, 3], 1);

    expect(runItem).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ outcome: "stopped", startedCount: 0, pendingCount: 3 });
  });

  it("does not leak a pre-run stop into the run after it", async () => {
    const runItem = vi.fn(async () => undefined);
    const executor = createExecutor(runItem);

    executor.stop();
    await executor.execute([1], 1);
    const summary = await executor.execute([1, 2], 1);

    expect(runItem).toHaveBeenCalledTimes(2);
    expect(summary.outcome).toBe("settled");
  });

  it("still stops a run that is already under way", async () => {
    let executor!: TaskExecutor<number, void>;
    const runItem = vi.fn(async () => {
      executor.stop();
    });
    executor = createExecutor(runItem);

    const summary = await executor.execute([1, 2, 3], 1);

    expect(runItem).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ outcome: "stopped", startedCount: 1 });
  });
});
