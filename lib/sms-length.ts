/** SOLAPI LMS limit: https://solapi.com/developers/api/messages-lms */
export const SMS_MAX_BYTES = 2_000;

/** ASCII=1, Korean/EUC-KR characters=2. Surrogate pairs count conservatively as 4.
 * This is a length guard, not validation of the provider's supported character set.
 */
export function smsByteLength(text: string): number {
  return text.replace(/[^\x00-\x7f]/g, "aa").length;
}
