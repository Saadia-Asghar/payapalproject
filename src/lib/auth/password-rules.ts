// Password policy shared by the server (enforced) and the browser (live hints).
export const PASSWORD_MIN = 10;

// The most common passwords that still pass the length rule.
const COMMON = new Set(["password123", "1234567890", "qwertyuiop", "password1234", "iloveyou123", "123456789a", "abcdefghij", "0987654321", "qwerty1234"]);

/** Returns why the password is not acceptable, or null. */
export function passwordProblem(password: string, email?: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > 200) return "Use at most 200 characters.";
  if (COMMON.has(password.toLowerCase()) || /^(.)\1+$/.test(password)) return "That password is too common. Choose something less guessable.";
  const name = email?.split("@")[0]?.toLowerCase() ?? "";
  if (name.length >= 4 && password.toLowerCase().includes(name)) return "Don't include your email name in the password.";
  return null;
}
