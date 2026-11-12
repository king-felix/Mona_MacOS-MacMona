import type { OperationKey, ProjectId, SubmissionState } from "../../shared/contracts";
import type { SubmissionStore } from "../engine/submission-store";
import type { StateStore } from "./store";

/**
 * P03's submission contract over the product database. Persist-before-send is
 * unchanged; the store is now transactional and part of the single write path.
 */
export class SqliteSubmissionStore implements SubmissionStore {
  constructor(
    private readonly store: StateStore,
    private readonly projectId: ProjectId | null = null,
  ) {}

  async put(state: SubmissionState): Promise<void> {
    await this.store.putSubmission(state, this.projectId);
  }

  async get(operationKey: OperationKey): Promise<SubmissionState | null> {
    return this.store.getSubmission(operationKey);
  }
}
