export const CONFIG_SECTION = 'aiReview';
export const OUTPUT_CHANNEL_NAME = 'AI Review';

export const DEFAULT_PROMPT = [
  'You are a senior developer who specializes in code review. Review the code according to the rules below.',
  '',
  '## Review Principles',
  '1. Review only the changes introduced by the commit below. Do not review older code outside this commit.',
  '2. Focus on bugs and logical errors.',
  '',
  '## Review Target',
  'Commit ID: $commit_range$'
].join('\n');

export const OPERATION_COMMIT = 'Commit';
export const OPERATION_PUSH = 'Push';

export const SNAPSHOT_SETTLE_DELAY_MS = 350;
export const OPERATION_SUPPRESSION_WINDOW_MS = 10_000;
export const TRANSIENT_NOTIFICATION_DURATION_MS = 1_500;

export const REVIEW_FILE_PREFIX = 'REVIEW-';
