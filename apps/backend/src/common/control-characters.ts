/**
 * True iff `value` contains any ASCII control character — codepoints
 * U+0000–U+001F or U+007F (DEL). The managed-upload path-resolvers in
 * `users.service` (avatar) and `reviews.service` (review photo) both
 * use this to reject decoded filenames that smuggle control chars
 * through `decodeURIComponent`, so a `%00pwn.jpg` URL doesn't make a
 * cascade `unlink` escape the managed directory.
 *
 * Exported as a shared util so the avatar and review-photo paths can't
 * drift apart when only one is patched.
 */
export function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}
