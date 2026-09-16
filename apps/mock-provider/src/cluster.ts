import { MockStats } from "@litellm-bench/contracts";
import { Data, Effect, Option, Ref, Schema } from "effect";
import cluster, { type Worker } from "node:cluster";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { emptyStats, mergeStats } from "./server.js";

export class WorkerExit extends Data.TaggedError("WorkerExit")<{
  readonly pid: number | undefined;
  readonly code: number | null;
  readonly signal: string | null;
}> {
  override get message(): string {
    return `mock worker ${this.pid ?? "?"} exited (${this.signal ?? `code ${this.code}`})`;
  }
}

/**
 * IPC protocol for `/__stats` across cluster workers. The worker that received the request asks the
 * primary, which collects every worker's local counters and returns the merged total.
 */
const StatsMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("stats.request"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("stats.collect"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("stats.report"), id: Schema.String, stats: MockStats }),
  Schema.Struct({ type: Schema.Literal("stats.result"), id: Schema.String, stats: MockStats }),
]);
type StatsMessage = typeof StatsMessage.Type;

const decodeMessage = Schema.decodeUnknownOption(StatsMessage);

type Collection = {
  readonly requester: Worker;
  readonly remaining: number;
  readonly stats: MockStats;
};

/**
 * Fork `count` workers that each serve the mock on the shared port, answer their `/__stats`
 * collections, and fail closed when any worker exits: a silently respawned worker would hide a
 * crash inside a measurement.
 */
export const supervise = (count: number): Effect.Effect<never, WorkerExit> =>
  Effect.callback<never, WorkerExit>((resume) => {
    const workers = Array.from({ length: count }, () => cluster.fork());
    const collections = new Map<string, Collection>();
    const onMessage = (worker: Worker, raw: unknown) => {
      const message = decodeMessage(raw);
      if (Option.isNone(message)) return;
      if (message.value.type === "stats.request") {
        collections.set(message.value.id, {
          requester: worker,
          remaining: workers.length,
          stats: emptyStats,
        });
        for (const target of workers) {
          target.send({ type: "stats.collect", id: message.value.id } satisfies StatsMessage);
        }
        return;
      }
      if (message.value.type !== "stats.report") return;
      const collection = collections.get(message.value.id);
      if (collection === undefined) return;
      const merged: Collection = {
        ...collection,
        remaining: collection.remaining - 1,
        stats: mergeStats(collection.stats, message.value.stats),
      };
      if (merged.remaining > 0) {
        collections.set(message.value.id, merged);
        return;
      }
      collections.delete(message.value.id);
      collection.requester.send(
        { type: "stats.result", id: message.value.id, stats: merged.stats } satisfies StatsMessage,
      );
    };
    const onExit = (worker: Worker, code: number, signal: string) => {
      resume(Effect.fail(new WorkerExit({ pid: worker.process.pid, code, signal })));
    };
    cluster.on("message", onMessage);
    cluster.on("exit", onExit);
    return Effect.sync(() => {
      cluster.off("message", onMessage);
      cluster.off("exit", onExit);
      for (const worker of workers) worker.kill();
    });
  });

const send = (message: StatsMessage) => {
  process.send?.(message);
};

/** Reply to the primary's collections with this worker's counters for as long as the scope lives. */
export const reportStats = (local: Ref.Ref<MockStats>): Effect.Effect<never> =>
  Effect.callback<never>(() => {
    const onMessage = (raw: unknown) => {
      const message = decodeMessage(raw);
      if (Option.isNone(message) || message.value.type !== "stats.collect") return;
      send({ type: "stats.report", id: message.value.id, stats: Ref.getUnsafe(local) });
    };
    process.on("message", onMessage);
    return Effect.sync(() => {
      process.off("message", onMessage);
    });
  });

/** Ask the primary for the cluster-wide counters; the local ones are already in the total. */
export const readClusterStats = (_local: MockStats): Effect.Effect<MockStats> =>
  Effect.callback<MockStats>((resume) => {
    const id = randomUUID();
    const onMessage = (raw: unknown) => {
      const message = decodeMessage(raw);
      if (Option.isNone(message) || message.value.type !== "stats.result") return;
      if (message.value.id !== id) return;
      process.off("message", onMessage);
      resume(Effect.succeed(message.value.stats));
    };
    process.on("message", onMessage);
    send({ type: "stats.request", id });
    return Effect.sync(() => {
      process.off("message", onMessage);
    });
  });
