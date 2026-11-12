/**
 * Styles Clerk's components (sign-in, sign-up, MFA setup, account menus) to
 * match the app. Clerk needs literal colours here; these mirror the tokens
 * in app/globals.css, which is the source of truth.
 */
export const clerkAppearance = {
  variables: {
    colorPrimary: "#a79cf5",
    colorBackground: "#161d38",
    colorText: "#eef0f8",
    colorTextSecondary: "#b4bbd3",
    colorDanger: "#f0776a",
    colorSuccess: "#5ed3a0",
    colorWarning: "#e8c25a",
    borderRadius: "5px",
    fontFamily: "var(--font-archivo), ui-sans-serif, system-ui, sans-serif",
  },
} as const;
