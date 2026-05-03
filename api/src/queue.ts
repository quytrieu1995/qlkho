import { Queue } from "bullmq";
import { redis } from "./redis.js";

export const syncQueue = new Queue("sync-events", {
  connection: redis
});
