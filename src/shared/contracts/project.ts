import { z } from "zod";
import { AbsolutePath, ProjectId, TaskId, Timestamp } from "./ids";

export const Project = z.strictObject({
  id: ProjectId,
  name: z.string().min(1).max(200),
  rootPath: AbsolutePath,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  archived: z.boolean(),
  pinned: z.boolean(),
});
export type Project = z.infer<typeof Project>;

export const TaskStatus = z.enum([
  "pending",
  "running",
  "paused",
  "blocked",
  "completed",
  "failed",
  "interrupted",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const Task = z.strictObject({
  id: TaskId,
  projectId: ProjectId,
  title: z.string().min(1).max(200),
  prompt: z.string().min(1),
  status: TaskStatus,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Task = z.infer<typeof Task>;
