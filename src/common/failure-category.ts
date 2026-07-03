/**
 * Classifies a failed pay-in into a category so analytics can separate customer
 * behaviour from real system reliability:
 *   ABANDONED — customer never completed (timed out / expired / never approved)
 *   DECLINED  — customer actively rejected/cancelled the prompt
 *   SYSTEM    — our system or the provider errored (the true reliability signal)
 *
 * Works both at failure time (pass the provider status) and heuristically for
 * historical rows (derive from the stored failureReason string).
 */
export type FailureCategory = 'ABANDONED' | 'DECLINED' | 'SYSTEM';

export function classifyFailure(reason?: string | null, providerStatus?: string | null): FailureCategory {
  const r = (reason ?? '').toLowerCase();
  const s = (providerStatus ?? '').toUpperCase();

  // Customer actively said no.
  if (s === 'CANCELLED' || /\bcancel|reject|declin|denied\b/.test(r)) return 'DECLINED';

  // Customer never completed — no approval before it timed out / expired.
  if (
    s === 'TIMEOUT' ||
    s === 'EXPIRED' ||
    /time.?d? ?out|expire|no confirmation|not approved|abandon|never (?:paid|started)/.test(r)
  ) {
    return 'ABANDONED';
  }

  // Anything else that reached "failed" is a provider/system error.
  return 'SYSTEM';
}

export type OutcomeBucket = 'success' | 'abandoned' | 'declined' | 'system' | 'inprogress';

/** Bucket a whole invoice from its status + (stored or derived) failure category. */
export function bucketInvoice(params: {
  status: string;
  failureCategory?: string | null;
  latestFailureReason?: string | null;
  expired: boolean;
}): OutcomeBucket {
  const { status, failureCategory, latestFailureReason, expired } = params;
  if (status === 'SUCCESS') return 'success';
  if (status === 'FAILED') {
    const cat = (failureCategory as FailureCategory | undefined) ?? classifyFailure(latestFailureReason);
    return cat === 'DECLINED' ? 'declined' : cat === 'ABANDONED' ? 'abandoned' : 'system';
  }
  if (status === 'CANCELLED') return 'declined';
  // PENDING / PROCESSING — dead if past expiry, otherwise still in flight.
  return expired ? 'abandoned' : 'inprogress';
}

/** Whose fault the outcome is — drives who needs to act on it. */
export type Blame = 'system' | 'customer' | 'none';

export interface OutcomeInsight {
  category: OutcomeBucket;
  blame: Blame;
  label: string;     // short badge label
  headline: string;  // one-line summary of what happened
  detail: string;    // fuller plain-English explanation for an admin/engineer
}

const OUTCOME_LABELS: Record<OutcomeBucket, string> = {
  success: 'Successful',
  abandoned: 'Abandoned',
  declined: 'Declined',
  system: 'System issue',
  inprogress: 'In progress',
};

/**
 * Turn a payment's status + failure signals into a human explanation an admin
 * or engineer can act on — specifically separating faults we caused (SYSTEM,
 * needs engineering) from customer behaviour (abandoned/declined, informational).
 */
export function explainOutcome(params: {
  status: string;
  failureCategory?: string | null;
  latestFailureReason?: string | null;
  expired: boolean;
  hasAttempt: boolean;
}): OutcomeInsight {
  const bucket = bucketInvoice(params);
  const label = OUTCOME_LABELS[bucket];
  const reason = (params.latestFailureReason ?? '').trim();
  const quoted = reason ? ` Provider said: “${reason}”.` : '';

  switch (bucket) {
    case 'success':
      return { category: bucket, blame: 'none', label, headline: 'Payment completed', detail: 'Funds were collected successfully.' };
    case 'declined':
      return {
        category: bucket,
        blame: 'customer',
        label,
        headline: 'Customer declined the prompt',
        detail: `The payer actively cancelled or rejected the payment prompt on their phone — nothing failed on our side.${quoted}`,
      };
    case 'abandoned':
      return {
        category: bucket,
        blame: 'customer',
        label,
        headline: params.hasAttempt ? 'Customer never approved' : 'Customer never started',
        detail: params.hasAttempt
          ? `A prompt was sent to the payer but they never approved it before it timed out — a customer drop-off, not a system fault.${quoted}`
          : 'The payment request expired before the payer entered any details or started paying. No attempt ever reached a provider.',
      };
    case 'system':
      return {
        category: bucket,
        blame: 'system',
        label,
        headline: 'Platform or provider error',
        detail: `This payment failed because of an error on our side or the provider’s — the customer was not at fault. This is what needs engineering attention.${quoted}`,
      };
    case 'inprogress':
    default:
      return { category: bucket, blame: 'none', label, headline: 'Awaiting confirmation', detail: 'The payment is still awaiting confirmation from the provider.' };
  }
}
