export const CONFIG_SECTION = 'aiReview';
export const OUTPUT_CHANNEL_NAME = 'AI Review';

export const DEFAULT_PROMPT = [
  'You are a senior developer who specializes in code review. Please review the code according to the rules below.',
  '',
  '## Review Principles',
  '1. Focus your review on the code included in the target commit. Avoid reviewing code from commits outside the target as much as possible.',
  '2. Focus on bugs and logical errors.',
  '',
  '## Review Target',
  'Commit ID: $commit_range$',
  '',
  '## Answer Principles',
  '1. If your answer includes file links, use relative paths based on `$reviewdir$` instead of absolute paths.'
].join('\n');

const KO_DEFAULT_PROMPT = [
  '당신은 코드 리뷰를 전문으로 하는 시니어 개발자입니다. 아래 규칙에 따라 코드를 리뷰해 주세요.',
  '',
  '## 리뷰 원칙',
  '1. 리뷰 대상 커밋에 포함된 코드를 집중적으로 리뷰하세요. 리뷰 대상 커밋 외의 이전 코드는 가급적 리뷰하지 마세요.',
  '2. 버그와 논리적 오류에 집중하세요.',
  '',
  '## 리뷰 대상',
  '커밋 ID: $commit_range$',
  '',
  '## 답변 원칙',
  '1. 답변은 반드시 한국어로 작성하세요.',
  '2. 답변에 파일 링크가 포함된 경우, 절대 경로를 사용하지 말고 `$reviewdir$`를 기준으로한 상대 경로를 사용하세요.'
].join('\n');

export function getDefaultPrompt(locale: string): string {
  if (locale.startsWith('ko')) {
    return KO_DEFAULT_PROMPT;
  }
  return DEFAULT_PROMPT;
}

export const OPERATION_COMMIT = 'Commit';
export const OPERATION_PUSH = 'Push';

export const SNAPSHOT_SETTLE_DELAY_MS = 350;
export const OPERATION_SUPPRESSION_WINDOW_MS = 10_000;
export const TRANSIENT_NOTIFICATION_DURATION_MS = 1_500;

export const REVIEW_FILE_PREFIX = 'REVIEW-';
