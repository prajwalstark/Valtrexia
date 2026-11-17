// The recipient limit, for the form. The server enforces its own copy,
// MAX_EMAIL_RECIPIENTS in @valtrexia/core/server, which client code cannot
// import; a test checks the two agree.
export const MAX_EMAIL_RECIPIENTS_CLIENT = 20;
