"use client";

import { useState, useTransition, type FormEvent } from "react";

/**
 * Runs a server action when a form is submitted and keeps its last result.
 *
 * Used instead of passing the action to `<form action>`: React resets every
 * field of a form submitted that way, after each submit, successful or not.
 * A refused save would lose what was typed, and a drop-down would fall back
 * to the entry it showed when the page loaded while the server held another.
 * Submitting by hand leaves the fields exactly as the person left them.
 */
export function useFormAction<State>(
  action: (previous: State, formData: FormData) => Promise<State>,
  initial: State,
): [state: State, onSubmit: (event: FormEvent<HTMLFormElement>) => void, pending: boolean] {
  const [state, setState] = useState(initial);
  const [pending, startTransition] = useTransition();

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      setState(await action(state, formData));
    });
  };
  return [state, onSubmit, pending];
}
