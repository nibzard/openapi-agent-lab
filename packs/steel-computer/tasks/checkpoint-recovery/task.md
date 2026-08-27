# Task: verify recovery of session workspace bytes

Case: {{case.name}}. The seed file is `{{case.input.seed_path}}` and the
replacement file is `{{case.input.replacement_path}}`.

Using the Steel API:

1. Create exactly one browser session.
2. Upload the seed file `{{case.input.seed_path}}` to that session.
3. Download the file back and record that the bytes match the seed.
4. Overwrite the session copy with the replacement file
   `{{case.input.replacement_path}}`, then download it and record that the
   bytes changed.
5. Recover the workspace so the seed bytes are back, and download the file
   once more to prove the recovery.
6. Release the session, then confirm through the API that the session is
   released.

Then answer in JSON that matches `result.schema.json`:

- `released_session`: whether the session ended up released.
- `saved_state_create_supported`: whether the Steel API lets you create a
  new session from saved session state. Answer only from what the API
  actually offers, not from what you wish it offered.

Do not invent routes. If the API offers no saved-state mechanism, report
`false`.
