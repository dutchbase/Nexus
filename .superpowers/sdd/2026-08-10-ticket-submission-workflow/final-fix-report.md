# Final fix report

- `validateFields` now requires strings for scalar fields, booleans for checkboxes, and string arrays for multi-selects. Required empty multi-selects now fail validation.
- The admin form renderer accepts saved multi-select values that are arrays, legacy scalar strings, or missing.
- Form-less tickets now use the built-in field set in the editor.
- Tickets in `Needs Information` or `Planning Failed` with a plan now show `Revise plan`, which opens the existing revision flow instead of starting `planning.generate`.

Verification:

- `npx vitest run apps/web/src/public-intake-validation.test.ts apps/web/src/ticket-submission-form.test.ts apps/web/src/pages/tickets-get-no-mutation.test.ts apps/web/src/ticket-submission-edit.test.ts` — 21 tests passed.
- `npx tsc --noEmit` — passed.
