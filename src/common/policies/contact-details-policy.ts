// Format rules for contact details shared by every entity that stores them (companies, contacts,
// leads). Deliberately simple: strict enough to catch pasted URLs and garbage, loose enough for
// real-world numbers. No libphonenumber: normalizing to E.164 is a feature, not a validation.

// Bare hostname such as `acme.com` or `sales.acme.co.uk`: no scheme, path, port or whitespace.
// Callers lowercase first. Labels are 1-63 chars, never start/end with a hyphen; at least one dot.
export const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

// Optional leading +, then digits with spaces, dots, dashes or parentheses (so "(02) 2345-6789"
// works); starts with a digit or "(", ends with a digit; 5-30 characters in all.
export const PHONE_PATTERN = /^\+?[0-9(][0-9 ().-]{3,28}[0-9]$/;
export const PHONE_MAX_LENGTH = 30;
