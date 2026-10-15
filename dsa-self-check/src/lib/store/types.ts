import type { SetId } from '../../content/types';
import type { BlockOrder, FeedbackData, Group, Participant, ParticipantPatch } from '../model';

export type FeedbackKey = 'feedback1' | 'feedback2';

/**
 * Persistence for one participant plus the shared counters and stats.
 * Every assignment method is idempotent: it re-reads the participant inside the
 * transaction and returns the stored value if one exists, so a retry or a
 * reload can never change a group, a block order or count a score twice.
 */
export interface Store {
  readonly kind: 'firebase' | 'local';
  /** uid of an already signed-in anonymous user (after a reload), or null. */
  existingUid(): Promise<string | null>;
  signIn(): Promise<string>;
  /** Testers only (debug reset): forget the anonymous user so the next Start is a new participant. */
  signOut(): Promise<void>;
  load(uid: string): Promise<Participant | null>;
  /** Creates participants/{uid}; sets createdAt/updatedAt. */
  create(p: Participant): Promise<void>;
  /** Merge-write; sets updatedAt. */
  save(uid: string, patch: ParticipantPatch): Promise<void>;
  /** counters/blockOrder (or pilot_blockOrder). */
  assignBlockOrder(uid: string, pilot: boolean): Promise<BlockOrder>;
  /** counters/group_{stratum} (or pilot_group_{stratum}); writes group + stratum + extra onto the participant. */
  assignGroup(uid: string, pilot: boolean, stratum: string, extra: ParticipantPatch): Promise<Group>;
  /**
   * Reads stats/{setId} (or pilot_{setId}), builds the feedback with the beats-%
   * computed from the counts *before* this participant, increments counts[score]
   * and stores the feedback on the participant, all in one transaction.
   */
  recordFeedback(
    uid: string,
    pilot: boolean,
    key: FeedbackKey,
    setId: SetId,
    score: number,
    build: (beatsPct: number) => FeedbackData,
  ): Promise<FeedbackData>;
}
