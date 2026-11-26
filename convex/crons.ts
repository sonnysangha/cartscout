import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "cleanup expired Oxylabs holds",
  { hours: 1 },
  internal.store.cleanupExpiredHolds,
  {},
);

export default crons;
